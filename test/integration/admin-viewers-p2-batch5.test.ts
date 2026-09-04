import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { createManualJournal, reverseJournal } from "@/lib/domains/accounting/journals"
import { listJournals } from "@/lib/domains/accounting/reports"
import { getJournalTrace } from "@/lib/domains/accounting/traceability"
import { createAsset } from "@/lib/domains/assets/assets"
import { startEncounter } from "@/lib/domains/clinical/encounters"
import { addDiagnosis, listPatientDiagnoses } from "@/lib/domains/clinical/diagnoses"
import { saveNote, getNoteHistory } from "@/lib/domains/clinical/notes"
import { createOrder, listPatientOrders } from "@/lib/domains/clinical/orders"
import { createPrescription, listPatientPrescriptions, getPrescription } from "@/lib/domains/clinical/prescriptions"
import { recordVitals, listPatientVitals } from "@/lib/domains/clinical/vitals"
import { listPatientMedicationHistory } from "@/lib/domains/pharmacy/dispensing"
import { listClinicalAccessLog } from "@/lib/platform/access-log"
import { ForbiddenError } from "@/lib/platform/permissions-core"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P2 Batch 5 (§6, §7) — read-only admin/accountant/security viewers. See
 * P2_REMEDIATION_REPORT.md for the full record.
 */
const TIMEOUT = 60000

describe("P2 §6: accounting traceability (Journal -> Journal Lines -> Source Reference, reversal relationship)", () => {
  let organizationId: string
  let branchId: string
  let userId: string
  let expenseAccountId: string
  let cashAccountId: string
  const journalIds: string[] = []
  const assetIds: string[] = []

  function session(perms: string[] = ["accounting.post", "accounting.view", "asset.manage"]): SessionContext {
    return {
      sessionId: "test-p2-batch5-accounting-trace",
      user: { id: userId, organizationId, email: "p2-batch5-accounting-test@test.local", firstName: "Trace", lastName: "Test" },
      activeBranchId: branchId,
      branchIds: [branchId],
      permissions: new Set(perms),
      roleNames: [],
    }
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id
    const user = await db.user.findFirstOrThrow({ where: { organizationId } })
    userId = user.id
    const [expense, cash] = await Promise.all([
      db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "5000" } }),
      db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "1000" } }),
    ])
    expenseAccountId = expense.id
    cashAccountId = cash.id
  }, TIMEOUT)

  afterAll(async () => {
    const journals = await db.journal.findMany({
      where: { organizationId, OR: [{ id: { in: journalIds } }, { referenceType: "manual_reversal", referenceId: { in: journalIds } }, { referenceType: "asset", referenceId: { in: assetIds } }] },
    })
    await db.journalLine.deleteMany({ where: { journalId: { in: journals.map((j) => j.id) } } })
    await db.journal.deleteMany({ where: { id: { in: journals.map((j) => j.id) } } })
    await db.asset.deleteMany({ where: { id: { in: assetIds } } })
    await db.$disconnect()
  }, TIMEOUT)

  it("a manual journal's source resolves to 'no source transaction', and the reversal relationship is traceable in both directions", async () => {
    const original = await createManualJournal(session(), {
      branchId, journalDate: new Date(), description: "P2B5 trace test entry",
      lines: [{ accountId: expenseAccountId, debit: 25, credit: 0 }, { accountId: cashAccountId, debit: 0, credit: 25 }],
    })
    journalIds.push(original.id)

    const originalTrace = await getJournalTrace(session(), original.id)
    expect(originalTrace.source?.summary).toMatch(/no source transaction/i)
    expect(originalTrace.related).toHaveLength(0) // not yet reversed

    const reversal = await reverseJournal(session(), original.id, "P2B5 test reversal")

    const reversalTrace = await getJournalTrace(session(), reversal.id)
    expect(reversalTrace.source?.summary).toContain(original.journalNumber)
    expect(reversalTrace.related).toHaveLength(1)
    expect(reversalTrace.related[0].relationship).toBe("reverses")
    expect(reversalTrace.related[0].id).toBe(original.id)

    const originalTraceAfter = await getJournalTrace(session(), original.id)
    expect(originalTraceAfter.related).toHaveLength(1)
    expect(originalTraceAfter.related[0].relationship).toBe("reversed by")
    expect(originalTraceAfter.related[0].id).toBe(reversal.id)
  }, TIMEOUT)

  it("an asset acquisition's journal resolves a real source summary and a working link to the asset's own page", async () => {
    const asset = await createAsset(session(), { branchId, name: "P2B5 Trace Test Asset", category: "equipment", cost: 750 })
    assetIds.push(asset.id)

    const journal = await db.journal.findFirstOrThrow({ where: { organizationId, referenceType: "asset", referenceId: asset.id } })
    journalIds.push(journal.id)

    const trace = await getJournalTrace(session(), journal.id)
    expect(trace.source?.label).toBe("Asset Acquisition")
    expect(trace.source?.summary).toContain(asset.name)
    expect(trace.source?.href).toBe(`/assets/${asset.id}`)
  }, TIMEOUT)

  it("listJournals' date range filter includes only journals within the window", async () => {
    const inWindow = await createManualJournal(session(), {
      branchId, journalDate: new Date("2019-03-15"), description: "P2B5 in-window",
      lines: [{ accountId: expenseAccountId, debit: 5, credit: 0 }, { accountId: cashAccountId, debit: 0, credit: 5 }],
    })
    journalIds.push(inWindow.id)
    const outOfWindow = await createManualJournal(session(), {
      branchId, journalDate: new Date("2019-06-15"), description: "P2B5 out-of-window",
      lines: [{ accountId: expenseAccountId, debit: 5, credit: 0 }, { accountId: cashAccountId, debit: 0, credit: 5 }],
    })
    journalIds.push(outOfWindow.id)

    const filtered = await listJournals(session(), { dateFrom: new Date("2019-03-01"), dateTo: new Date("2019-03-31") })
    const ids = filtered.journals.map((j) => j.id)
    expect(ids).toContain(inWindow.id)
    expect(ids).not.toContain(outOfWindow.id)
  }, TIMEOUT)

  it("both listJournals and getJournalTrace are gated on accounting.view", async () => {
    const noPerms = session([])
    await expect(listJournals(noPerms)).rejects.toThrow(ForbiddenError)

    const journal = await createManualJournal(session(), {
      branchId, journalDate: new Date(), description: "P2B5 permission-gate test",
      lines: [{ accountId: expenseAccountId, debit: 1, credit: 0 }, { accountId: cashAccountId, debit: 0, credit: 1 }],
    })
    journalIds.push(journal.id)
    await expect(getJournalTrace(noPerms, journal.id)).rejects.toThrow(ForbiddenError)
  }, TIMEOUT)
})

describe("P2 §7: clinical access log — write-side gap closure and admin viewer", () => {
  let organizationId: string
  let branchId: string
  let providerId: string
  let userId: string
  let patientId: string
  let encounterId: string
  const patientIds: string[] = []
  const encounterIds: string[] = []

  function session(perms: string[]): SessionContext {
    return {
      sessionId: "test-p2-batch5-access-log",
      user: { id: userId, organizationId, email: "p2-batch5-access-log-test@test.local", firstName: "Access", lastName: "Test" },
      activeBranchId: branchId,
      branchIds: [branchId],
      permissions: new Set(perms),
      roleNames: [],
    }
  }

  const fullClinicalSession = () =>
    session(["encounter.create", "encounter.view", "clinical_notes.edit", "clinical_notes.view", "order.create", "lab_order.create", "prescription.create", "vitals.record", "patient.view", "audit.review"])

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id
    const user = await db.user.findFirstOrThrow({ where: { organizationId } })
    userId = user.id
    const provider = await db.provider.findFirstOrThrow({ where: { organizationId } })
    providerId = provider.id

    const patient = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchId,
        mrn: `TESTP2B5-${Date.now()}`, firstName: "P2Batch5", lastName: "AccessLog",
        dob: new Date("1985-01-01"), gender: "unknown", mobile: `P2B5-${Date.now()}`,
      },
    })
    patientId = patient.id
    patientIds.push(patientId)

    const encounter = await startEncounter(fullClinicalSession(), { branchId, patientId, providerId, encounterType: "consultation" })
    encounterId = encounter.id
    encounterIds.push(encounterId)
  }, TIMEOUT)

  afterAll(async () => {
    // P0-06: clinical_access_log is deliberately insert-only — the app's
    // real runtime role (what `db` connects as) has no DELETE grant on it
    // at the database level, on purpose (see audit-log-immutability.test.ts
    // for the same property on audit_log). Cleanup needs the schema-owner
    // connection instead; `patient`'s own FK to it is ON DELETE RESTRICT,
    // so the patient row can't be removed either until its log rows are.
    const adapter = new PrismaPg({ connectionString: process.env.DIRECT_DATABASE_URL })
    const ownerDb = new PrismaClient({ adapter })
    await ownerDb.clinicalAccessLog.deleteMany({ where: { patientId: { in: patientIds } } })
    await ownerDb.$disconnect()

    await db.diagnosis.deleteMany({ where: { patientId: { in: patientIds } } })
    await db.clinicalNote.deleteMany({ where: { patientId: { in: patientIds } } })
    await db.prescriptionItem.deleteMany({ where: { prescription: { patientId: { in: patientIds } } } })
    await db.prescription.deleteMany({ where: { patientId: { in: patientIds } } })
    await db.clinicalOrder.deleteMany({ where: { patientId: { in: patientIds } } })
    await db.vitalSign.deleteMany({ where: { patientId: { in: patientIds } } })
    await db.encounter.deleteMany({ where: { id: { in: encounterIds } } })
    await db.patient.deleteMany({ where: { id: { in: patientIds } } })
    await db.$disconnect()
  }, TIMEOUT)

  it("reading a patient's diagnoses, orders, prescriptions, vitals, medication history, and note history each writes a real ClinicalAccessLog entry", async () => {
    const cs = fullClinicalSession()

    await addDiagnosis(cs, encounterId, { description: "P2B5 test diagnosis", isPrimary: true })
    await listPatientDiagnoses(cs, patientId)
    const diagLog = await db.clinicalAccessLog.findFirst({ where: { patientId, resourceType: "diagnoses" }, orderBy: { createdAt: "desc" } })
    expect(diagLog).not.toBeNull()

    const note = await saveNote(cs, encounterId, "consultation", { noteType: "consultation", content: "P2B5 test note content" })
    await getNoteHistory(cs, note.id)
    const noteLog = await db.clinicalAccessLog.findFirst({ where: { patientId, resourceType: "clinical_note", resourceId: note.id } })
    expect(noteLog).not.toBeNull()

    await createOrder(cs, encounterId, { orderType: "other", priority: "routine", procedureName: "P2B5 test procedure" })
    await listPatientOrders(cs, patientId)
    const orderLog = await db.clinicalAccessLog.findFirst({ where: { patientId, resourceType: "clinical_orders" }, orderBy: { createdAt: "desc" } })
    expect(orderLog).not.toBeNull()

    const prescription = await createPrescription(cs, encounterId, {
      items: [{ medicationName: "P2B5 Test Med", dose: "1 tab", frequency: "BID", route: "oral" }],
    })
    await listPatientPrescriptions(cs, patientId)
    const rxListLog = await db.clinicalAccessLog.findFirst({ where: { patientId, resourceType: "prescriptions" }, orderBy: { createdAt: "desc" } })
    expect(rxListLog).not.toBeNull()
    await getPrescription(cs, prescription.id)
    const rxGetLog = await db.clinicalAccessLog.findFirst({ where: { patientId, resourceType: "prescription", resourceId: prescription.id } })
    expect(rxGetLog).not.toBeNull()

    await recordVitals(cs, encounterId, { pulseBpm: 72 });
    await listPatientVitals(cs, patientId)
    const vitalsLog = await db.clinicalAccessLog.findFirst({ where: { patientId, resourceType: "vital_signs" }, orderBy: { createdAt: "desc" } })
    expect(vitalsLog).not.toBeNull()

    await listPatientMedicationHistory(cs, patientId)
    const medHistLog = await db.clinicalAccessLog.findFirst({ where: { patientId, resourceType: "medication_history" }, orderBy: { createdAt: "desc" } })
    expect(medHistLog).not.toBeNull()
  }, TIMEOUT)

  it("listClinicalAccessLog filters correctly by user, patient, action, and date range", async () => {
    const cs = fullClinicalSession()
    await listPatientVitals(cs, patientId) // ensure at least one fresh "view" entry for this user/patient

    const byPatient = await listClinicalAccessLog(cs, { patientId })
    expect(byPatient.entries.length).toBeGreaterThan(0)
    expect(byPatient.entries.every((e) => e.patientId === patientId)).toBe(true)

    const byUser = await listClinicalAccessLog(cs, { userId })
    expect(byUser.entries.length).toBeGreaterThan(0)
    expect(byUser.entries.every((e) => e.userId === userId)).toBe(true)

    const byAction = await listClinicalAccessLog(cs, { patientId, action: "view" })
    expect(byAction.entries.every((e) => e.action === "view")).toBe(true)

    const farFuture = await listClinicalAccessLog(cs, { patientId, dateFrom: new Date("2099-01-01") })
    expect(farFuture.entries).toHaveLength(0)
    expect(farFuture.total).toBe(0)
  }, TIMEOUT)

  it("listClinicalAccessLog's branch filter matches via the patient's registration branch", async () => {
    const cs = fullClinicalSession()
    const matching = await listClinicalAccessLog(cs, { patientId, branchId })
    expect(matching.entries.length).toBeGreaterThan(0)

    const otherBranch = await db.branch.findFirst({ where: { organizationId, id: { not: branchId } } })
    if (otherBranch) {
      const nonMatching = await listClinicalAccessLog(cs, { patientId, branchId: otherBranch.id })
      expect(nonMatching.entries).toHaveLength(0)
    }
  }, TIMEOUT)

  it("listClinicalAccessLog is gated on audit.review — a session without it is rejected", async () => {
    const noPerms = session(["encounter.view"])
    await expect(listClinicalAccessLog(noPerms, { patientId })).rejects.toThrow(ForbiddenError)
  }, TIMEOUT)
})
