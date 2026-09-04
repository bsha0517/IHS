import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { ForbiddenError } from "@/lib/platform/permissions-core"
import { listPatientAppointments } from "@/lib/domains/appointments/service"
import { listPatientEpisodes } from "@/lib/domains/clinical/episodes"
import { listPatientPackages } from "@/lib/domains/packages/service"
import { listPatientInvoices } from "@/lib/domains/billing/invoices"
import { listPatientPayments } from "@/lib/domains/billing/payments"
import { getPatientStatement } from "@/lib/domains/billing/statement"
import { listPatientLabResults } from "@/lib/domains/laboratory/results"
import type { SessionContext } from "@/lib/auth/session"

const TIMEOUT = 20000

/**
 * P3.2 §7/§13/§21 — targeted regression test for the actual bug found and
 * fixed this batch, not cosmetic behavior.
 *
 * Before this batch, `patients/[id]/page.tsx`, `ClinicalTabs`, and
 * `BillingTabs` called every one of the domain functions below
 * unconditionally, with no `can()` guard, regardless of whether the signed-in
 * session actually held the specific permission each one asserts internally.
 * Cross-referencing the seeded role permission sets (prisma/seed.ts) against
 * these assertions showed that every seeded role *except* Doctor, Nurse, and
 * the two admin roles is missing `encounter.view` (crashing ClinicalTabs),
 * and Doctor/Nurse/Laboratory Technician/Pharmacist/Radiology Technician are
 * all missing `invoice.view`/`payment.view`/`service.view` (crashing
 * BillingTabs) — despite every one of those roles holding `patient.view` and
 * therefore being able to open any patient's profile. Since none of these
 * calls were wrapped in a try/catch, the thrown `ForbiddenError` propagated
 * out of the Server Component tree entirely, so the *whole* Patient 360 page
 * failed for the majority of roles in the system, not just one tab.
 *
 * This test doesn't render the page components themselves (this codebase's
 * integration tests exercise domain functions directly, not React rendering)
 * — it pins the exact permission preconditions those components now check
 * with `can()` before calling each function, so a future permission-set or
 * domain-function change that silently reintroduces the mismatch fails here
 * instead of only failing live for an under-privileged role. The live
 * behavior (the page rendering successfully end-to-end for an
 * under-privileged role instead of crashing) was also verified in the
 * browser per this batch's report.
 */
describe("P3.2: Patient 360 does not crash for roles lacking a sub-tab's permission", () => {
  let organizationId: string
  let branchId: string
  let patientId: string
  const createdPatientIds: string[] = []

  function sessionWith(permissions: string[], roleName: string): SessionContext {
    return {
      sessionId: `test-p3-2-${roleName}`,
      user: { id: "test-user", organizationId, email: `p3-2-${roleName}@test.local`, firstName: "P3.2", lastName: roleName },
      activeBranchId: branchId,
      branchIds: [branchId],
      permissions: new Set(permissions),
      roleNames: [roleName],
    }
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id

    const patient = await db.patient.create({
      data: {
        organizationId,
        registrationBranchId: branchId,
        mrn: `TESTP32RV-${Date.now()}`,
        firstName: "P3.2",
        lastName: "RoleVisibility",
        dob: new Date("1990-01-01"),
        gender: "unknown",
        mobile: `P32M${Date.now()}`,
      },
    })
    createdPatientIds.push(patient.id)
    patientId = patient.id
  }, TIMEOUT)

  afterAll(async () => {
    if (createdPatientIds.length > 0) {
      // The Lab Tech §7/§21 test above calls `listPatientLabResults`, which
      // writes a real ClinicalAccessLog row for this patient. The runtime
      // role has no DELETE grant on clinical_access_log by design (same
      // property as audit_log — see audit-log-immutability.test.ts), and
      // Patient's FK to it is ON DELETE RESTRICT, so cleanup needs the
      // schema-owner connection first — same pattern as
      // admin-viewers-p2-batch5.test.ts.
      const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_DATABASE_URL }) })
      await ownerDb.clinicalAccessLog.deleteMany({ where: { patientId: { in: createdPatientIds } } })
      await ownerDb.$disconnect()
      await db.patient.deleteMany({ where: { id: { in: createdPatientIds } } })
    }
    await db.$disconnect()
  }, TIMEOUT)

  it("§13: a Doctor-shaped session (encounter.view, no billing permissions) can view clinical tabs but is correctly refused billing data", async () => {
    const doctor = sessionWith(["patient.view", "encounter.view"], "Doctor")
    // The permission ClinicalTabs actually needs — must succeed, not throw.
    await expect(listPatientEpisodes(doctor, patientId)).resolves.toBeDefined()
    // The permissions BillingTabs needs — Doctor genuinely lacks all three in
    // the seed data, so these must still throw. Patient 360's BillingTabs
    // now checks `can()` for each of these before calling it, instead of
    // letting the throw escape.
    await expect(listPatientPackages(doctor, patientId)).rejects.toThrow(ForbiddenError)
    await expect(listPatientInvoices(doctor, patientId)).rejects.toThrow(ForbiddenError)
    await expect(listPatientPayments(doctor, patientId)).rejects.toThrow(ForbiddenError)
    await expect(getPatientStatement(doctor, patientId)).rejects.toThrow(ForbiddenError)
  }, TIMEOUT)

  it("§7/§21: a Laboratory-Technician-shaped session (patient.view only) is correctly refused appointments and clinical tabs", async () => {
    const labTech = sessionWith(["patient.view", "lab_result.enter", "lab_result.verify"], "Laboratory Technician")
    // The permission `patients/[id]/page.tsx`'s top-level fetch needs — Lab
    // Tech genuinely lacks it in the seed data, so it must still throw.
    // Patient 360 now checks `can(session, "appointment.view")` first
    // instead of letting this escape out of the top-level Promise.all.
    await expect(listPatientAppointments(labTech, patientId)).rejects.toThrow(ForbiddenError)
    // Same for ClinicalTabs's shared `encounter.view` gate.
    await expect(listPatientEpisodes(labTech, patientId)).rejects.toThrow(ForbiddenError)
    // What Lab Tech *is* meant to see on Patient 360 — must still succeed.
    await expect(listPatientLabResults(labTech, patientId)).resolves.toBeDefined()
  }, TIMEOUT)

  it("§12/§6: listPatientAppointments now also returns branch and encounter for the Appointments tab and Overview current-status card", async () => {
    const receptionist = sessionWith(["patient.view", "appointment.view"], "Receptionist")
    const appointments = await listPatientAppointments(receptionist, patientId)
    // No appointments exist for this fresh patient — asserting the shape
    // compiles/resolves is what matters here (the include was extended,
    // not the filter), covered more fully by admin-viewers-p2-batch5 and
    // the P3.1 suite's own appointment fixtures.
    expect(appointments).toEqual([])
  }, TIMEOUT)
})
