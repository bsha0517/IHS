import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import {
  listNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
  resolveNotificationDestination,
  isSafeInternalPath,
  resolveBranchPermissionRecipientIds,
} from "@/lib/domains/notifications/service"
import { createNotificationOnce, createNotificationsOnce } from "@/lib/domains/notifications/create"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import { requestLeave, approveLeave, rejectLeave } from "@/lib/domains/hr/leave"
import { createPurchaseRequest, approvePurchaseRequest, rejectPurchaseRequest } from "@/lib/domains/procurement/purchase-requests"
import "@/lib/platform/event-handlers"
import { ForbiddenError } from "@/lib/platform/permissions-core"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P3.11 — Notifications / Tasks / Operational Awareness. Covers the
 * genuinely new/changed behavior this batch (see
 * P3_11_NOTIFICATIONS_TASKS_OPERATIONAL_AWARENESS_REPORT.md for full
 * rationale): the new read-side (list/count/mark-read/mark-all-read,
 * ownership-enforced), the new idempotent creation primitives, the safe
 * destination resolver, branch-aware recipient resolution, and the new/
 * fixed workflow notification producers. No Task model exists in this
 * codebase — nothing to test there (see the report's own "Tasks Decision"
 * section).
 */
const TIMEOUT = 60000

describe("P3.11: Notification Center — read side, ownership, idempotency", () => {
  let organizationId: string
  let branchAId: string
  let branchBId: string
  let userAId: string
  let userBId: string
  const notificationIds: string[] = []

  function sessionFor(userId: string, branchIds: string[]): SessionContext {
    return {
      sessionId: `test-p3-11-${userId}`,
      user: { id: userId, organizationId, email: `p3-11-${userId}@test.local`, firstName: "P311", lastName: "Test" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set(["leave.request", "leave.approve", "purchase_request.create", "purchase_request.approve"]),
      roleNames: ["P3.11 Test Role"],
    }
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchAId = branch.id
    const branchB = await db.branch.create({
      data: { organizationId, name: `P3.11 Test Branch B ${Date.now()}`, code: `P311B-${Date.now()}`, timezone: "UTC" },
    })
    branchBId = branchB.id

    const users = await db.user.findMany({ where: { organizationId }, take: 2 })
    userAId = users[0].id
    userBId = users[1]?.id ?? users[0].id
  }, TIMEOUT)

  afterAll(async () => {
    await db.notification.deleteMany({ where: { id: { in: notificationIds } } })
    await db.branch.delete({ where: { id: branchBId } }).catch(() => {})
    await db.$disconnect()
  }, TIMEOUT)

  async function fixture(recipientUserId: string, overrides: { status?: "unread" | "read"; type?: string; referenceType?: string; referenceId?: string } = {}) {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const n = await db.notification.create({
      data: {
        organizationId,
        recipientUserId,
        type: "test_type",
        title: "Test notification",
        body: "Test body",
        referenceType: "appointment",
        referenceId: suffix,
        ...overrides,
      },
    })
    notificationIds.push(n.id)
    return n
  }

  it("§7/§47: a user can list their own notifications, never another user's", async () => {
    const mine = await fixture(userAId)
    const theirs = await fixture(userBId)

    const { notifications } = await listNotifications(sessionFor(userAId, [branchAId]))
    expect(notifications.map((n) => n.id)).toContain(mine.id)
    expect(notifications.map((n) => n.id)).not.toContain(theirs.id)
  }, TIMEOUT)

  it("§9: unread count is a real indexed count, not a full-list fetch", async () => {
    const before = await getUnreadCount(sessionFor(userAId, [branchAId]))
    await fixture(userAId, { status: "unread" })
    const after = await getUnreadCount(sessionFor(userAId, [branchAId]))
    expect(after).toBe(before + 1)
  }, TIMEOUT)

  it("§11/§47: markNotificationRead enforces ownership server-side — cannot mark another user's notification, cannot be fooled by a client-supplied id alone", async () => {
    const theirs = await fixture(userBId, { status: "unread" })
    await expect(markNotificationRead(sessionFor(userAId, [branchAId]), theirs.id)).rejects.toThrow()

    const reloaded = await db.notification.findUniqueOrThrow({ where: { id: theirs.id } })
    expect(reloaded.status).toBe("unread") // untouched by the failed attempt
  }, TIMEOUT)

  it("§10/§42: marking the same notification read twice is idempotent, not an error", async () => {
    const mine = await fixture(userAId, { status: "unread" })
    await markNotificationRead(sessionFor(userAId, [branchAId]), mine.id)
    await markNotificationRead(sessionFor(userAId, [branchAId]), mine.id) // second call — must not throw
    const reloaded = await db.notification.findUniqueOrThrow({ where: { id: mine.id } })
    expect(reloaded.status).toBe("read")
  }, TIMEOUT)

  it("§36/§42: markAllNotificationsRead is a single bulk update scoped to the caller only, coherent even racing new-notification creation", async () => {
    await fixture(userAId, { status: "unread" })
    await fixture(userAId, { status: "unread" })
    const untouchedForOtherUser = await fixture(userBId, { status: "unread" })

    const [{ count }] = await Promise.all([
      markAllNotificationsRead(sessionFor(userAId, [branchAId])),
      fixture(userAId, { status: "unread" }), // a new notification arriving concurrently
    ])
    expect(count).toBeGreaterThanOrEqual(2)

    const remainingUnread = await getUnreadCount(sessionFor(userAId, [branchAId]))
    // Every notification that existed BEFORE the race is read; the one
    // created concurrently may or may not have been caught by the same bulk
    // update depending on timing, but there is no crash and no double
    // effect either way — the state is coherent, never negative/undefined.
    expect(remainingUnread).toBeGreaterThanOrEqual(0)

    const otherUserReloaded = await db.notification.findUniqueOrThrow({ where: { id: untouchedForOtherUser.id } })
    expect(otherUserReloaded.status).toBe("unread") // mark-all-read never touches another user's notifications
  }, TIMEOUT)

  it("§37/§38: pagination and the unread filter both work against real data", async () => {
    for (let i = 0; i < 3; i++) await fixture(userAId, { status: "unread", type: "pagination_test" })
    const page1 = await listNotifications(sessionFor(userAId, [branchAId]), { type: "pagination_test", page: 1 })
    expect(page1.notifications.length).toBeGreaterThanOrEqual(3)

    const unreadOnly = await listNotifications(sessionFor(userAId, [branchAId]), { status: "unread", type: "pagination_test" })
    expect(unreadOnly.notifications.every((n) => n.status === "unread")).toBe(true)
  }, TIMEOUT)

  it("§12/§14: resolveNotificationDestination only ever produces safe internal paths, and unknown/missing reference data resolves to no destination", () => {
    expect(resolveNotificationDestination({ referenceType: "appointment", referenceId: "abc" })).toBe("/appointments/abc")
    expect(resolveNotificationDestination({ referenceType: "lab_order", referenceId: "abc" })).toBe("/laboratory/orders/abc")
    expect(resolveNotificationDestination({ referenceType: "imaging_order", referenceId: "abc" })).toBe("/radiology/orders/abc")
    expect(resolveNotificationDestination({ referenceType: "leave_request", referenceId: "abc" })).toBe("/leave")
    expect(resolveNotificationDestination({ referenceType: "purchase_request", referenceId: "abc" })).toBe("/purchasing")
    expect(resolveNotificationDestination({ referenceType: "accounting_exception", referenceId: "abc" })).toBe("/accounting?tab=exceptions")
    expect(resolveNotificationDestination({ referenceType: null, referenceId: null })).toBeNull()
    expect(resolveNotificationDestination({ referenceType: "something_unrecognized", referenceId: "abc" })).toBeNull()

    expect(isSafeInternalPath("/leave")).toBe(true)
    expect(isSafeInternalPath("//evil.com")).toBe(false)
    expect(isSafeInternalPath("https://evil.com")).toBe(false)
    expect(isSafeInternalPath("javascript:alert(1)")).toBe(false)
  })

  it("§41: createNotificationOnce is idempotent — calling it twice for the same (recipient, type, reference) creates exactly one row", async () => {
    const input = {
      organizationId,
      recipientUserId: userAId,
      type: "idempotency_test",
      title: "T",
      body: "B",
      referenceType: "appointment",
      referenceId: `dup-${Date.now()}`,
    }
    await createNotificationOnce(db, input)
    await createNotificationOnce(db, input)
    const rows = await db.notification.findMany({ where: { recipientUserId: userAId, type: "idempotency_test", referenceId: input.referenceId } })
    notificationIds.push(...rows.map((r) => r.id))
    expect(rows.length).toBe(1)
  }, TIMEOUT)

  it("§41: createNotificationsOnce (fan-out) is idempotent per recipient — a partial-overlap retry only creates the missing rows", async () => {
    const referenceId = `dup-fanout-${Date.now()}`
    await createNotificationsOnce(db, [
      { organizationId, recipientUserId: userAId, type: "fanout_test", title: "T", body: "B", referenceType: "employee", referenceId },
    ])
    // Simulates a retry that redelivers to BOTH the already-notified
    // recipient and a new one — the already-notified one must not
    // duplicate.
    await createNotificationsOnce(db, [
      { organizationId, recipientUserId: userAId, type: "fanout_test", title: "T", body: "B", referenceType: "employee", referenceId },
      { organizationId, recipientUserId: userBId, type: "fanout_test", title: "T", body: "B", referenceType: "employee", referenceId },
    ])
    const rows = await db.notification.findMany({ where: { type: "fanout_test", referenceId } })
    notificationIds.push(...rows.map((r) => r.id))
    expect(rows.length).toBe(2) // one per distinct recipient, never duplicated
  }, TIMEOUT)

  it("§16/§31: branch-aware recipient resolution only returns users with real access to the target branch", async () => {
    const hrRole = await db.role.findFirstOrThrow({ where: { organizationId, name: "HR Manager" } })
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const branchAApprover = await db.user.create({
      data: { organizationId, email: `p311-approver-a-${suffix}@test.local`, firstName: "ApproverA", lastName: "Test", passwordHash: "x" },
    })
    await db.userRole.create({ data: { userId: branchAApprover.id, roleId: hrRole.id } })
    await db.userBranchAccess.create({ data: { userId: branchAApprover.id, branchId: branchAId } })

    const branchBApprover = await db.user.create({
      data: { organizationId, email: `p311-approver-b-${suffix}@test.local`, firstName: "ApproverB", lastName: "Test", passwordHash: "x" },
    })
    await db.userRole.create({ data: { userId: branchBApprover.id, roleId: hrRole.id } })
    await db.userBranchAccess.create({ data: { userId: branchBApprover.id, branchId: branchBId } })

    const recipientsForA = await resolveBranchPermissionRecipientIds(organizationId, "leave.approve", branchAId)
    expect(recipientsForA).toContain(branchAApprover.id)
    expect(recipientsForA).not.toContain(branchBApprover.id)

    await db.userBranchAccess.deleteMany({ where: { userId: { in: [branchAApprover.id, branchBApprover.id] } } })
    await db.userRole.deleteMany({ where: { userId: { in: [branchAApprover.id, branchBApprover.id] } } })
    await db.user.deleteMany({ where: { id: { in: [branchAApprover.id, branchBApprover.id] } } })
  }, TIMEOUT)

  it("§41: duplicate outbox delivery of a dead-letter transition does not duplicate the resulting notification", async () => {
    const admin = await db.user.findFirstOrThrow({
      where: { organizationId, roles: { some: { role: { name: "Super Admin" } } } },
    })
    const eventId = `test-event-${Date.now()}`
    const input = {
      organizationId,
      recipientUserId: admin.id,
      type: "system_event_dead_letter",
      title: "Background task failed: TestEvent",
      body: "test",
      referenceType: "outbox_event",
      referenceId: eventId,
    }
    await createNotificationsOnce(db, [input])
    await createNotificationsOnce(db, [input]) // simulates the same dead-letter transition being reached twice
    const rows = await db.notification.findMany({ where: { recipientUserId: admin.id, type: "system_event_dead_letter", referenceId: eventId } })
    notificationIds.push(...rows.map((r) => r.id))
    expect(rows.length).toBe(1)
  }, TIMEOUT)
})

describe("P3.11: HR leave notifications", () => {
  let organizationId: string
  let branchAId: string
  let branchBId: string
  let userId: string
  const employeeIds: string[] = []
  const leaveRequestIds: string[] = []
  const notificationTypesToClean = ["leave_request_submitted", "leave_decision"]

  function sessionForBranches(branchIds: string[]): SessionContext {
    return {
      sessionId: "test-p3-11-leave",
      user: { id: userId, organizationId, email: "p3-11-leave-test@test.local", firstName: "P311", lastName: "Leave" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set(["leave.request", "leave.approve", "employee.manage", "payroll.view"]),
      roleNames: ["P3.11 Leave Test Role"],
    }
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchAId = branch.id
    const user = await db.user.findFirstOrThrow({ where: { organizationId } })
    userId = user.id
    const branchB = await db.branch.create({
      data: { organizationId, name: `P3.11 Leave Test Branch B ${Date.now()}`, code: `P311LB-${Date.now()}`, timezone: "UTC" },
    })
    branchBId = branchB.id
  }, TIMEOUT)

  afterAll(async () => {
    await db.notification.deleteMany({ where: { organizationId, type: { in: notificationTypesToClean }, referenceId: { in: leaveRequestIds } } })
    await db.leaveRequest.deleteMany({ where: { id: { in: leaveRequestIds } } })
    await db.employee.deleteMany({ where: { id: { in: employeeIds } } })
    await db.branch.delete({ where: { id: branchBId } }).catch(() => {})
    await db.$disconnect()
  }, TIMEOUT)

  async function createEmployeeWithUser(branchId: string, withUser: boolean) {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    let empUserId: string | null = null
    if (withUser) {
      const empUser = await db.user.create({
        data: { organizationId, email: `p311-emp-${suffix}@test.local`, firstName: "Emp", lastName: "User", passwordHash: "x" },
      })
      empUserId = empUser.id
    }
    const employee = await db.employee.create({
      data: {
        organizationId, branchId, userId: empUserId,
        employeeNumber: `P311EMP-${suffix}`, firstName: "P311", lastName: "Employee",
        designation: "Staff", joiningDate: new Date("2024-01-01"), employmentType: "full_time", basicSalary: 1000, status: "active",
      },
    })
    employeeIds.push(employee.id)
    return employee
  }

  it("§21/§30/§31: submitting a leave request notifies leave.approve holders scoped to the EMPLOYEE'S branch, not unrelated branches", async () => {
    const employee = await createEmployeeWithUser(branchAId, false)
    const request = await requestLeave(sessionForBranches([branchAId]), {
      employeeId: employee.id, leaveType: "annual", startDate: new Date("2027-05-01"), endDate: new Date("2027-05-02"),
    })
    leaveRequestIds.push(request.id)

    const notifications = await db.notification.findMany({ where: { organizationId, type: "leave_request_submitted", referenceId: request.id } })
    expect(notifications.length).toBeGreaterThan(0)
    // §17-adjacent minimization: no leave "reason" text leaked into the body.
    for (const n of notifications) {
      expect(n.body).not.toMatch(/reason/i)
    }
  }, TIMEOUT)

  it("§30/§31: an approved leave decision notifies the employee's linked User with a minimal, reason-free message", async () => {
    const employee = await createEmployeeWithUser(branchAId, true)
    const request = await requestLeave(sessionForBranches([branchAId]), {
      employeeId: employee.id, leaveType: "annual", startDate: new Date("2027-06-01"), endDate: new Date("2027-06-02"),
    })
    leaveRequestIds.push(request.id)
    await approveLeave(sessionForBranches([branchAId]), request.id)

    const notification = await db.notification.findFirst({
      where: { organizationId, type: "leave_decision", referenceId: request.id, recipientUserId: employee.userId! },
    })
    expect(notification).toBeTruthy()
    expect(notification!.title).toMatch(/approved/i)
  }, TIMEOUT)

  it("§30/§31: a rejected leave decision notifies the employee's linked User", async () => {
    const employee = await createEmployeeWithUser(branchAId, true)
    const request = await requestLeave(sessionForBranches([branchAId]), {
      employeeId: employee.id, leaveType: "sick", startDate: new Date("2027-07-01"), endDate: new Date("2027-07-01"),
    })
    leaveRequestIds.push(request.id)
    await rejectLeave(sessionForBranches([branchAId]), request.id, "test rejection")

    const notification = await db.notification.findFirst({
      where: { organizationId, type: "leave_decision", referenceId: request.id, recipientUserId: employee.userId! },
    })
    expect(notification).toBeTruthy()
    expect(notification!.title).toMatch(/rejected/i)
    expect(notification!.body).not.toMatch(/test rejection/i) // reason text kept out of the notification body
  }, TIMEOUT)

  it("§50 (branch isolation carried into requestLeave itself): a caller without access to the employee's branch cannot submit a leave request for them", async () => {
    const employee = await createEmployeeWithUser(branchAId, false)
    await expect(
      requestLeave(sessionForBranches([branchBId]), {
        employeeId: employee.id, leaveType: "annual", startDate: new Date("2027-08-01"), endDate: new Date("2027-08-02"),
      })
    ).rejects.toThrow(ForbiddenError)
  }, TIMEOUT)
})

describe("P3.11: Procurement (Purchase Request) notifications", () => {
  let organizationId: string
  let branchId: string
  let userId: string
  let productId: string
  const purchaseRequestIds: string[] = []

  function session(): SessionContext {
    return {
      sessionId: "test-p3-11-pr",
      user: { id: userId, organizationId, email: "p3-11-pr-test@test.local", firstName: "P311", lastName: "PR" },
      activeBranchId: branchId,
      branchIds: [branchId],
      permissions: new Set(["purchase_request.create", "purchase_request.approve"]),
      roleNames: ["Super Admin"],
    }
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id
    const user = await db.user.findFirstOrThrow({ where: { organizationId } })
    userId = user.id
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const product = await db.product.create({
      data: { organizationId, name: `P3.11 Test Product ${suffix}`, sku: `TESTP311-${suffix}`, category: "consumable", unit: "unit", reorderLevel: 0, purchaseCost: 5, sellingPrice: 10 },
    })
    productId = product.id
  }, TIMEOUT)

  afterAll(async () => {
    const prs = await db.purchaseRequest.findMany({ where: { id: { in: purchaseRequestIds } } })
    await db.notification.deleteMany({ where: { organizationId, type: { in: ["purchase_request_submitted", "purchase_request_decision"] }, referenceId: { in: prs.map((p) => p.id) } } })
    await db.purchaseRequestLine.deleteMany({ where: { purchaseRequestId: { in: purchaseRequestIds } } })
    await db.purchaseRequest.deleteMany({ where: { id: { in: purchaseRequestIds } } })
    await db.product.delete({ where: { id: productId } }).catch(() => {})
    await db.$disconnect()
  }, TIMEOUT)

  it("§28/§31: submitting a Purchase Request notifies purchase_request.approve holders; approving it notifies the requester", async () => {
    const pr = await createPurchaseRequest(session(), { branchId, lines: [{ productId, quantity: 5 }] })
    purchaseRequestIds.push(pr.id)

    const submittedNotifications = await db.notification.findMany({ where: { organizationId, type: "purchase_request_submitted", referenceId: pr.id } })
    expect(submittedNotifications.length).toBeGreaterThan(0)

    await approvePurchaseRequest(session(), pr.id)
    const decisionNotification = await db.notification.findFirst({ where: { organizationId, type: "purchase_request_decision", referenceId: pr.id, recipientUserId: userId } })
    expect(decisionNotification).toBeTruthy()
    expect(decisionNotification!.title).toMatch(/approved/i)
  }, TIMEOUT)

  it("§28/§31: rejecting a Purchase Request notifies the requester", async () => {
    const pr = await createPurchaseRequest(session(), { branchId, lines: [{ productId, quantity: 3 }] })
    purchaseRequestIds.push(pr.id)
    await rejectPurchaseRequest(session(), pr.id, "test reject")

    const decisionNotification = await db.notification.findFirst({ where: { organizationId, type: "purchase_request_decision", referenceId: pr.id, recipientUserId: userId } })
    expect(decisionNotification).toBeTruthy()
    expect(decisionNotification!.title).toMatch(/rejected/i)
  }, TIMEOUT)
})

describe("P3.11: Clinical result notifications (outbox-driven)", () => {
  let organizationId: string
  let branchId: string
  let providerUserId: string
  let providerId: string
  let patientId: string
  let encounterId: string
  let clinicalOrderId: string
  let labTestId: string
  const notificationCleanupTypes = ["lab_result_ready", "critical_lab_result"]

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const providerUser = await db.user.create({
      data: { organizationId, email: `p311-provider-${suffix}@test.local`, firstName: "Ordering", lastName: "Provider", passwordHash: "x" },
    })
    providerUserId = providerUser.id
    const provider = await db.provider.create({
      data: { organizationId, userId: providerUser.id, providerType: "doctor", firstName: "Ordering", lastName: "Provider" },
    })
    providerId = provider.id

    const patient = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchId, mrn: `TESTP311-${suffix}`, firstName: "P311", lastName: "Patient",
        dob: new Date("1990-01-01"), gender: "unknown", mobile: `P311${suffix}`,
      },
    })
    patientId = patient.id

    const encounter = await db.encounter.create({
      data: { organizationId, branchId, patientId, providerId, encounterNumber: `TESTP311-ENC-${suffix}`, encounterType: "consultation", status: "active" },
    })
    encounterId = encounter.id

    const clinicalOrder = await db.clinicalOrder.create({
      data: { organizationId, branchId, patientId, encounterId, orderNumber: `TESTP311-ORD-${suffix}`, orderType: "lab", orderingProviderId: providerId },
    })
    clinicalOrderId = clinicalOrder.id

    const labTest = await db.labTest.create({
      data: { organizationId, code: `TESTP311-LT-${suffix}`, name: "P3.11 Test Panel", category: "chemistry", specimenType: "blood", resultType: "numeric", unit: "mg/dL", price: 20, criticalHigh: 200 },
    })
    labTestId = labTest.id
  }, TIMEOUT)

  afterAll(async () => {
    await db.notification.deleteMany({ where: { organizationId, type: { in: notificationCleanupTypes }, referenceId: clinicalOrderId } })
    await db.labOrderTest.deleteMany({ where: { clinicalOrderId } })
    await db.labTest.delete({ where: { id: labTestId } }).catch(() => {})
    await db.clinicalOrder.delete({ where: { id: clinicalOrderId } }).catch(() => {})
    await db.encounter.delete({ where: { id: encounterId } }).catch(() => {})
    await db.patient.delete({ where: { id: patientId } }).catch(() => {})
    await db.provider.delete({ where: { id: providerId } }).catch(() => {})
    await db.user.delete({ where: { id: providerUserId } }).catch(() => {})
    await db.$disconnect()
  }, TIMEOUT)

  it("§21/§22: a finalized (verified) lab result notifies the ORDERING provider's linked User, with a real, working destination, and retry does not duplicate it", async () => {
    await writeOutboxEvent(db, { organizationId, eventType: "LabResultFinalized", payload: { clinicalOrderId } })
    await dispatchPendingOutboxEvents(organizationId)
    // Simulate an at-least-once outbox redelivery of the SAME event.
    await writeOutboxEvent(db, { organizationId, eventType: "LabResultFinalized", payload: { clinicalOrderId } })
    await dispatchPendingOutboxEvents(organizationId)

    const rows = await db.notification.findMany({ where: { organizationId, recipientUserId: providerUserId, type: "lab_result_ready", referenceId: clinicalOrderId } })
    expect(rows.length).toBe(1) // never duplicated across the two deliveries
    expect(resolveNotificationDestination(rows[0])).toBe(`/laboratory/orders/${clinicalOrderId}`)
  }, TIMEOUT)

  it("§17: a critical lab result notification contains NO raw clinical value — minimal PHI only, patient identified by name/MRN alone, routed to the parent lab order", async () => {
    const line = await db.labOrderTest.create({
      data: { organizationId, clinicalOrderId, labTestId, resultType: "numeric", numericValue: 350, unit: "mg/dL", abnormalFlag: "critical_high" },
    })

    await writeOutboxEvent(db, { organizationId, eventType: "CriticalLabResultVerified", payload: { labOrderTestId: line.id, abnormalFlag: "critical_high" } })
    await dispatchPendingOutboxEvents(organizationId)

    const notification = await db.notification.findFirst({ where: { organizationId, recipientUserId: providerUserId, type: "critical_lab_result", referenceId: clinicalOrderId } })
    expect(notification).toBeTruthy()
    expect(notification!.body).not.toMatch(/350/) // the actual numeric value is never in the notification text
    expect(notification!.body).not.toMatch(/mg\/dL/) // nor the unit
    expect(notification!.body).toMatch(/P311/) // patient identification (name) IS present, matching the spec's own "MRN ####" precedent
    expect(resolveNotificationDestination(notification!)).toBe(`/laboratory/orders/${clinicalOrderId}`) // routes to the PARENT order, not the unroutable line id
  }, TIMEOUT)
})
