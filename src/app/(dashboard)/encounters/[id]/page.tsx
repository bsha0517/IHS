import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { getEncounter, listPatientEncounters } from "@/lib/domains/clinical/encounters"
import { loadOrNotFound } from "@/lib/platform/not-found"
import { getNoteHistory } from "@/lib/domains/clinical/notes"
import { listProviders } from "@/lib/domains/providers/service"
import { serializeDecimals } from "@/lib/utils/serialize"
import { EncounterHeader } from "@/app/(dashboard)/encounters/[id]/encounter-header"
import { PatientSummarySidebar } from "@/app/(dashboard)/encounters/[id]/patient-summary-sidebar"
import { NoteForm } from "@/app/(dashboard)/encounters/[id]/note-form"
import { VitalsSection } from "@/app/(dashboard)/encounters/[id]/vitals-section"
import { DiagnosesSection } from "@/app/(dashboard)/encounters/[id]/diagnoses-section"
import { OrdersSection } from "@/app/(dashboard)/encounters/[id]/orders-section"
import { PrescriptionsSection } from "@/app/(dashboard)/encounters/[id]/prescriptions-section"
import { FollowUpSection } from "@/app/(dashboard)/encounters/[id]/follow-up-section"

export default async function EncounterWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession()
  if (!session || !can(session, "encounter.view")) redirect("/dashboard")

  const { id } = await params
  // Every value below crosses into "use client" sections further down this
  // page (EncounterHeader, VitalsSection, PatientSummarySidebar) — Prisma's
  // Decimal instances (Provider.consultationFee, VitalSign.heightCm/weightKg/
  // bmi/temperatureCelsius/bloodGlucoseMgDl) can't survive that boundary, so
  // serialize once here rather than re-deriving Decimal-free field picks at
  // every call site (see src/lib/utils/serialize.ts).
  // Targeted backlog closure, item 4 — see loadOrNotFound's own doc comment.
  const encounter = serializeDecimals(await loadOrNotFound(() => getEncounter(session, id)))

  // P3.3 §7/§34: `listProviders` needs `provider.view`, which Nurse — a role
  // that already holds `encounter.view` and can reach this page — does not
  // have in the seeded permission set. This was called unconditionally,
  // crashing the whole encounter workspace for Nurse. Gated the same way
  // Patient 360's equivalent dialog-option fetches were fixed in P3.2.
  const canViewProviderOptions = can(session, "provider.view")
  const canViewNoteHistory = can(session, "clinical_notes.view")
  const consultationNote = encounter.notes.find((n) => n.noteType === "consultation") ?? null
  const [previousEncountersRaw, providers, noteHistory] = await Promise.all([
    listPatientEncounters(session, encounter.patientId),
    canViewProviderOptions ? listProviders(session) : Promise.resolve([]),
    // P3.3 §25/§26: `getNoteHistory` already existed (used elsewhere for
    // admin/access-log purposes) but was never wired into the encounter
    // workspace — a doctor had no way to see a note's amendment chain
    // (original content, author, date) from here at all. Only fetched when
    // there's a current note to look up; a plain draft note with no
    // amendments yet returns a same-length chain of 1, cheaply.
    consultationNote && canViewNoteHistory ? getNoteHistory(session, consultationNote.id) : Promise.resolve([]),
  ])
  const previousEncounters = serializeDecimals(
    previousEncountersRaw.filter((e) => e.id !== encounter.id).slice(0, 5)
  )

  const canEdit = can(session, "clinical_notes.edit") && encounter.status !== "finalized"
  // P3.4 §20/§23: previously shared `canEdit` (gated on `clinical_notes.edit`,
  // the doctor's note-editing permission) with every other section — Nurse
  // holds `vitals.record` but not `clinical_notes.edit`, so opening this
  // same encounter workspace to record pre-consultation vitals would have
  // shown the Vitals form as fully read-only, with no way to actually
  // record anything despite the domain layer already accepting the write.
  const canRecordVitals = can(session, "vitals.record") && encounter.status !== "finalized"
  const canFinalize = can(session, "encounter.finalize")
  const providerOptions = providers.map((p) => ({ id: p.id, firstName: p.firstName, lastName: p.lastName }))

  return (
    <div className="flex flex-col gap-6">
      <EncounterHeader encounter={encounter} canFinalize={canFinalize} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[280px_1fr]">
        <PatientSummarySidebar patient={encounter.patient} previousEncounters={previousEncounters} vitals={encounter.vitalSigns} />

        <div className="flex flex-col gap-6">
          <VitalsSection encounterId={encounter.id} vitals={encounter.vitalSigns} canEdit={canRecordVitals} />
          <NoteForm encounterId={encounter.id} note={consultationNote} history={serializeDecimals(noteHistory)} canEdit={canEdit} />
          <DiagnosesSection encounterId={encounter.id} diagnoses={encounter.diagnoses} canEdit={canEdit} />
          <OrdersSection encounterId={encounter.id} orders={encounter.orders} providers={providerOptions} canEdit={canEdit} />
          <PrescriptionsSection encounterId={encounter.id} prescriptions={encounter.prescriptions} canEdit={canEdit} />
          <FollowUpSection encounterId={encounter.id} followUps={encounter.followUps} canEdit={canEdit} />
        </div>
      </div>
    </div>
  )
}
