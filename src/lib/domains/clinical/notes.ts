import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { writeClinicalAccessLog } from "@/lib/platform/access-log"
import { getAuthorizedBranchScope, assertBranchAccess } from "@/lib/platform/branch-scope"
import type { SessionContext } from "@/lib/auth/session"
import type { ClinicalNoteInput } from "@/lib/domains/clinical/schemas"

/**
 * Freely editable while draft (in place — not every keystroke needs to be an
 * "amendment"). Once the current note of this type is finalized, this throws;
 * callers must go through createAmendment instead. This is what makes the
 * "finalized notes are never silently overwritten" rule (spec.md §25/§92)
 * actually hold, rather than being a convention someone can forget in a form.
 */
export async function saveNote(
  session: SessionContext,
  encounterId: string,
  noteType: ClinicalNoteInput["noteType"],
  input: ClinicalNoteInput
) {
  assertCan(session, "clinical_notes.edit")

  // P3.3 §33: see clinical/vitals.ts's comment — `findFirstOrThrow` leaked
  // a raw Prisma message for a stale/invalid encounterId.
  const encounter = await db.encounter.findFirst({
    where: { id: encounterId, organizationId: session.user.organizationId },
  })
  if (!encounter) throw new Error("This encounter no longer exists or is not accessible.")
  // P3.3 §34: same branch-write gap fixed across every encounter-scoped
  // write this batch touched — see clinical/vitals.ts's comment for the
  // full reasoning.
  assertBranchAccess(getAuthorizedBranchScope(session), encounter.branchId)

  const current = await db.clinicalNote.findFirst({
    where: { encounterId, noteType, isCurrent: true },
  })

  if (current && current.status === "finalized") {
    throw new Error("This note is finalized. Create an amendment to correct it.")
  }

  const data = {
    chiefComplaint: input.chiefComplaint ?? null,
    historyOfPresentIllness: input.historyOfPresentIllness ?? null,
    reviewOfSystems: input.reviewOfSystems ?? null,
    examinationFindings: input.examinationFindings ?? null,
    assessment: input.assessment ?? null,
    treatmentPlan: input.treatmentPlan ?? null,
    content: input.content ?? null,
  }

  if (current) {
    const updated = await db.clinicalNote.update({ where: { id: current.id }, data })
    await auditFromSession(session, "update", "clinical_note", current.id, { new: data })
    return updated
  }

  const created = await db.clinicalNote.create({
    data: {
      organizationId: session.user.organizationId,
      encounterId,
      patientId: encounter.patientId,
      noteType,
      authoredBy: session.user.id,
      ...data,
    },
  })
  await auditFromSession(session, "create", "clinical_note", created.id, { new: data })
  return created
}

/** Corrects a finalized note by creating a new current version, preserving the original as history. */
export async function createAmendment(session: SessionContext, noteId: string, input: ClinicalNoteInput) {
  assertCan(session, "clinical_notes.edit")

  // Targeted backlog closure, item 6 — see clinical/diagnoses.ts's identical comment.
  const original = await db.clinicalNote.findFirst({
    where: { id: noteId, organizationId: session.user.organizationId },
    include: { encounter: { select: { branchId: true } } },
  })
  if (!original) throw new Error("This clinical note no longer exists or is not accessible.")
  // P3.3 §34: same branch-write gap fixed across every encounter-scoped
  // write this batch touched — see clinical/vitals.ts's comment for the
  // full reasoning. `encounter` is only selected for this check, at no
  // extra round trip (Prisma resolves it as part of the same query).
  assertBranchAccess(getAuthorizedBranchScope(session), original.encounter.branchId)
  if (!original.isCurrent) {
    throw new Error("Only the current version of a note can be amended.")
  }
  if (original.status !== "finalized") {
    throw new Error("Only a finalized note needs an amendment — edit the draft directly instead.")
  }

  const amendment = await db.$transaction(async (tx) => {
    await tx.clinicalNote.update({ where: { id: original.id }, data: { isCurrent: false } })
    return tx.clinicalNote.create({
      data: {
        organizationId: session.user.organizationId,
        encounterId: original.encounterId,
        patientId: original.patientId,
        noteType: original.noteType,
        amendsId: original.id,
        authoredBy: session.user.id,
        // An amendment only ever targets an already-finalized note (guarded
        // above), and finalizeEncounter's bulk draft->finalized sweep has
        // already run by then — so this note must be born finalized, or it's
        // stuck as an orphaned draft nothing can ever edit or display.
        status: "finalized",
        finalizedBy: session.user.id,
        finalizedAt: new Date(),
        chiefComplaint: input.chiefComplaint ?? null,
        historyOfPresentIllness: input.historyOfPresentIllness ?? null,
        reviewOfSystems: input.reviewOfSystems ?? null,
        examinationFindings: input.examinationFindings ?? null,
        assessment: input.assessment ?? null,
        treatmentPlan: input.treatmentPlan ?? null,
        content: input.content ?? null,
      },
    })
  })

  await auditFromSession(session, "amend", "clinical_note", amendment.id, {
    old: { amends: original.id },
    new: { noteType: amendment.noteType },
  })

  return amendment
}

/** Full version chain for a note, oldest first — for an audit/history view. */
export async function getNoteHistory(session: SessionContext, currentNoteId: string) {
  assertCan(session, "clinical_notes.view")
  const chain = []
  // P3.3 §25/§26: `authoredByUser`/`finalizedByUser` added so the encounter
  // workspace's new history view can show a real author name — previously
  // only the caller-invisible raw user ids were available.
  let cursor = await db.clinicalNote.findFirst({
    where: { id: currentNoteId, organizationId: session.user.organizationId },
    include: { encounter: true, authoredByUser: { select: { firstName: true, lastName: true } }, finalizedByUser: { select: { firstName: true, lastName: true } } },
  })
  if (cursor) assertBranchAccess(getAuthorizedBranchScope(session), cursor.encounter.branchId)
  while (cursor) {
    chain.unshift(cursor)
    if (!cursor.amendsId) break
    // Re-check organizationId on every hop — amendsId is a same-org chain by
    // construction, but this is the boundary of a fetch reachable with only
    // a note id, so it must not implicitly trust that invariant.
    cursor = await db.clinicalNote.findFirst({
      where: { id: cursor.amendsId, organizationId: session.user.organizationId },
      include: { encounter: true, authoredByUser: { select: { firstName: true, lastName: true } }, finalizedByUser: { select: { firstName: true, lastName: true } } },
    })
  }
  // P2 §7: clinical notes are the most sensitive chart content this system
  // has — SOAP/assessment/plan free text — and reading their full amendment
  // history had no access-log coverage at all before this batch, the exact
  // "chart access" gap P2.md names.
  if (chain.length > 0) {
    await writeClinicalAccessLog({ session, patientId: chain[0].patientId, resourceType: "clinical_note", resourceId: currentNoteId, action: "view" })
  }
  return chain
}
