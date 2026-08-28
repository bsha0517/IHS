import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { approveLeave } from "@/lib/domains/hr/leave"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P1 §25: leave-balance entitlement enforcement (transaction-safe,
 * override-authorized) and the "existing appointments during newly
 * approved leave must trigger a conflict warning, never be silently
 * deleted/rescheduled" requirement — real DB integration tests.
 */
const TIMEOUT = 60000

describe("P1 §25: leave balance integrity and appointment-conflict notification", () => {
  let organizationId: string
  let branchId: string
  let userId: string
  const employeeIds: string[] = []
  const leaveRequestIds: string[] = []
  const providerIds: string[] = []
  const appointmentIds: string[] = []
  const patientIds: string[] = []

  function session(): SessionContext {
    return {
      sessionId: "test-leave-balance",
      user: { id: userId, organizationId, email: "leave-balance-test@test.local", firstName: "Leave", lastName: "Test" },
      activeBranchId: branchId,
      branchIds: [branchId],
      permissions: new Set(["leave.approve", "leave.request", "employee.manage"]),
      roleNames: ["Super Admin"],
    }
  }

  async function newEmployee() {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const employee = await db.employee.create({
      data: {
        organizationId, branchId,
        employeeNumber: `TESTLEAVE-${suffix}`,
        firstName: "Leave", lastName: "TestEmployee",
        designation: "Staff", joiningDate: new Date("2024-01-01"),
        employmentType: "full_time", basicSalary: 2000, status: "active",
      },
    })
    employeeIds.push(employee.id)
    return employee
  }

  async function newRequest(employeeId: string, leaveType: "annual" | "sick" | "unpaid", startDate: Date, days: number) {
    const endDate = new Date(startDate.getTime() + (days - 1) * 24 * 60 * 60 * 1000)
    const request = await db.leaveRequest.create({
      data: { organizationId, employeeId, leaveType, startDate, endDate, days, reason: "test leave request" },
    })
    leaveRequestIds.push(request.id)
    return request
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id
    const user = await db.user.findFirstOrThrow({ where: { organizationId } })
    userId = user.id
  }, TIMEOUT)

  afterAll(async () => {
    await db.notification.deleteMany({ where: { organizationId, type: "leave_appointment_conflict" } }).catch(() => {})
    await db.appointment.deleteMany({ where: { id: { in: appointmentIds } } })
    await db.providerLeaveBlock.deleteMany({ where: { providerId: { in: providerIds } } })
    await db.leaveRequest.deleteMany({ where: { id: { in: leaveRequestIds } } })
    await db.leaveBalance.deleteMany({ where: { employeeId: { in: employeeIds } } })
    await db.provider.deleteMany({ where: { id: { in: providerIds } } })
    await db.employee.deleteMany({ where: { id: { in: employeeIds } } })
    await db.patient.deleteMany({ where: { id: { in: patientIds } } })
    await db.$disconnect()
  }, TIMEOUT)

  it("approves within the configured entitlement", async () => {
    const employee = await newEmployee()
    const year = new Date().getUTCFullYear()
    await db.leaveBalance.create({ data: { organizationId, employeeId: employee.id, leaveType: "annual", year, allocatedDays: 10 } })
    const request = await newRequest(employee.id, "annual", new Date(Date.UTC(year, 5, 1)), 5)

    const approved = await approveLeave(session(), request.id)
    expect(approved.status).toBe("approved")
  }, TIMEOUT)

  it("blocks approval that would exceed the configured entitlement", async () => {
    const employee = await newEmployee()
    const year = new Date().getUTCFullYear()
    await db.leaveBalance.create({ data: { organizationId, employeeId: employee.id, leaveType: "annual", year, allocatedDays: 5 } })
    const request = await newRequest(employee.id, "annual", new Date(Date.UTC(year, 5, 1)), 10)

    await expect(approveLeave(session(), request.id)).rejects.toThrow(/would exceed the employee's annual leave entitlement/)
    const stillRequested = await db.leaveRequest.findUniqueOrThrow({ where: { id: request.id } })
    expect(stillRequested.status).toBe("requested")
  }, TIMEOUT)

  it("allows an explicit override to approve beyond entitlement", async () => {
    const employee = await newEmployee()
    const year = new Date().getUTCFullYear()
    await db.leaveBalance.create({ data: { organizationId, employeeId: employee.id, leaveType: "annual", year, allocatedDays: 5 } })
    const request = await newRequest(employee.id, "annual", new Date(Date.UTC(year, 5, 1)), 10)

    const approved = await approveLeave(session(), request.id, { allowOverride: true })
    expect(approved.status).toBe("approved")
  }, TIMEOUT)

  it("unpaid leave is exempt from the entitlement check entirely — no balance row needed", async () => {
    const employee = await newEmployee()
    const request = await newRequest(employee.id, "unpaid", new Date(Date.UTC(new Date().getUTCFullYear(), 5, 1)), 30)

    const approved = await approveLeave(session(), request.id)
    expect(approved.status).toBe("approved")
  }, TIMEOUT)

  it("approving accumulates correctly against the same balance across multiple requests, blocking once exhausted", async () => {
    const employee = await newEmployee()
    const year = new Date().getUTCFullYear()
    await db.leaveBalance.create({ data: { organizationId, employeeId: employee.id, leaveType: "sick", year, allocatedDays: 8 } })

    const request1 = await newRequest(employee.id, "sick", new Date(Date.UTC(year, 2, 1)), 5)
    await approveLeave(session(), request1.id)

    const request2 = await newRequest(employee.id, "sick", new Date(Date.UTC(year, 6, 1)), 4) // 5 + 4 = 9 > 8
    await expect(approveLeave(session(), request2.id)).rejects.toThrow(/would exceed the employee's sick leave entitlement \(3 day\(s\) remaining, 4 requested\)/)
  }, TIMEOUT)

  it("no balance row configured for that leave type/year — approves without a check (nothing configured to violate)", async () => {
    const employee = await newEmployee()
    const request = await newRequest(employee.id, "annual", new Date(Date.UTC(new Date().getUTCFullYear(), 5, 1)), 100)
    const approved = await approveLeave(session(), request.id)
    expect(approved.status).toBe("approved")
  }, TIMEOUT)

  it("concurrency: two simultaneous approvals against the same balance never together exceed it", async () => {
    const employee = await newEmployee()
    const year = new Date().getUTCFullYear()
    await db.leaveBalance.create({ data: { organizationId, employeeId: employee.id, leaveType: "annual", year, allocatedDays: 10 } })
    const requestA = await newRequest(employee.id, "annual", new Date(Date.UTC(year, 2, 1)), 6)
    const requestB = await newRequest(employee.id, "annual", new Date(Date.UTC(year, 8, 1)), 6) // 6 + 6 = 12 > 10

    const results = await Promise.allSettled([approveLeave(session(), requestA.id), approveLeave(session(), requestB.id)])
    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    expect(fulfilled.length).toBe(1) // only one of the two 6-day requests was allowed through
    expect(rejected.length).toBe(1)

    const approvedCount = await db.leaveRequest.count({ where: { id: { in: [requestA.id, requestB.id] }, status: "approved" } })
    expect(approvedCount).toBe(1)
  }, TIMEOUT)

  describe("appointment conflict on newly approved provider leave", () => {
    async function newProviderEmployee() {
      const employee = await newEmployee()
      const provider = await db.provider.create({
        data: { organizationId, providerType: "doctor", firstName: employee.firstName, lastName: `ConflictTest-${Date.now()}`, employeeId: employee.id },
      })
      providerIds.push(provider.id)
      return { employee, provider }
    }

    async function newPatient() {
      const patient = await db.patient.create({
        data: {
          organizationId, registrationBranchId: branchId,
          mrn: `TESTLEAVECONFLICT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, firstName: "Conflict", lastName: "Patient",
          dob: new Date("1990-01-01"), gender: "unknown", mobile: `LC${Date.now()}${Math.random().toString(36).slice(2, 4)}`,
        },
      })
      patientIds.push(patient.id)
      return patient
    }

    it("notifies admins of a conflicting appointment and does NOT cancel or reschedule it", async () => {
      const { employee, provider } = await newProviderEmployee()
      const patient = await newPatient()
      const year = new Date().getUTCFullYear()

      const leaveStart = new Date(Date.UTC(year, 9, 10))
      const leaveEnd = new Date(Date.UTC(year, 9, 12))
      const appointmentStart = new Date(Date.UTC(year, 9, 11, 10, 0))
      const appointment = await db.appointment.create({
        data: {
          organizationId, branchId, patientId: patient.id, providerId: provider.id,
          appointmentNumber: `TESTAPT-CONFLICT-${Date.now()}`,
          startTime: appointmentStart, endTime: new Date(appointmentStart.getTime() + 30 * 60 * 1000),
          status: "scheduled",
        },
      })
      appointmentIds.push(appointment.id)

      const request = await newRequest(employee.id, "unpaid", leaveStart, 3)
      await db.leaveRequest.update({ where: { id: request.id }, data: { endDate: leaveEnd } })
      await approveLeave(session(), request.id)

      const notification = await db.notification.findFirstOrThrow({ where: { organizationId, type: "leave_appointment_conflict", referenceId: employee.id } })
      expect(notification.body).toMatch(/NOT automatically cancelled or rescheduled/)

      // The appointment itself is completely untouched.
      const stillScheduled = await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } })
      expect(stillScheduled.status).toBe("scheduled")
      expect(stillScheduled.startTime.getTime()).toBe(appointmentStart.getTime())
    }, TIMEOUT)

    it("no notification when there is no conflicting appointment", async () => {
      const { employee } = await newProviderEmployee()
      const year = new Date().getUTCFullYear()
      const request = await newRequest(employee.id, "unpaid", new Date(Date.UTC(year, 10, 1)), 2)
      await approveLeave(session(), request.id)

      const notification = await db.notification.findFirst({ where: { organizationId, type: "leave_appointment_conflict", referenceId: employee.id } })
      expect(notification).toBeNull()
    }, TIMEOUT)
  })
})
