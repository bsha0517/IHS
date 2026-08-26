import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"

/**
 * Real integration test against the actual database. Confirms the Postgres
 * `EXCLUDE USING gist` constraint (`appointment_provider_no_overlap`, Phase 2
 * — see DATABASE.md) genuinely rejects two overlapping appointments for the
 * same provider at the database level, independent of any application-layer
 * check — the actual race-condition-prevention mechanism this build has
 * relied on and re-verified by hand since Phase 2 (most recently reused
 * as-is by Phase 12's public booking flow). Inserts directly via Prisma,
 * bypassing the service layer's leave/permission checks entirely, to isolate
 * the DB constraint itself as the thing under test.
 */
describe("appointment_provider_no_overlap DB exclusion constraint", () => {
  let organizationId: string
  let branchId: string
  let patientId: string
  let providerId: string
  const createdAppointmentIds: string[] = []
  const start = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) // one year out — never collides with real scheduled activity
  const end = new Date(start.getTime() + 30 * 60 * 1000)

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id
    patientId = (await db.patient.findFirstOrThrow({ where: { organizationId } })).id
    providerId = (await db.provider.findFirstOrThrow({ where: { organizationId } })).id
  })

  afterAll(async () => {
    if (createdAppointmentIds.length > 0) {
      await db.appointment.deleteMany({ where: { id: { in: createdAppointmentIds } } })
    }
    await db.$disconnect()
  })

  it("allows the first booking for a slot", async () => {
    const appt = await db.appointment.create({
      data: {
        organizationId,
        branchId,
        appointmentNumber: `TEST-${Date.now()}-A`,
        patientId,
        providerId,
        startTime: start,
        endTime: end,
      },
    })
    createdAppointmentIds.push(appt.id)
    expect(appt.id).toBeTruthy()
  })

  it("rejects a second, overlapping booking for the same provider", async () => {
    const overlapStart = new Date(start.getTime() + 10 * 60 * 1000) // starts 10min into the first appointment
    const overlapEnd = new Date(overlapStart.getTime() + 30 * 60 * 1000)

    await expect(
      db.appointment.create({
        data: {
          organizationId,
          branchId,
          appointmentNumber: `TEST-${Date.now()}-B`,
          patientId,
          providerId,
          startTime: overlapStart,
          endTime: overlapEnd,
        },
      })
    ).rejects.toThrow()
  })

  it("allows a second booking for the same provider once it no longer overlaps", async () => {
    const nextStart = end // starts exactly when the first ends — adjacent, not overlapping
    const nextEnd = new Date(nextStart.getTime() + 30 * 60 * 1000)

    const appt = await db.appointment.create({
      data: {
        organizationId,
        branchId,
        appointmentNumber: `TEST-${Date.now()}-C`,
        patientId,
        providerId,
        startTime: nextStart,
        endTime: nextEnd,
      },
    })
    createdAppointmentIds.push(appt.id)
    expect(appt.id).toBeTruthy()
  })
})
