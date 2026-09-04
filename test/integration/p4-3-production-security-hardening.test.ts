import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { login } from "@/lib/auth/service"
import { portalLogin } from "@/lib/auth/portal-service"
import { createSession, revokeSession, getSessionContext } from "@/lib/auth/session"
import { getPortalSessionContext } from "@/lib/auth/portal-session"
import { checkIpRateLimit } from "@/lib/auth/rate-limit"
import { safeInternalRedirectPath } from "@/lib/platform/safe-redirect"
import { hashPassword } from "@/lib/auth/password"
import { getPatient } from "@/lib/domains/patients/service"
import { getInvoice, generateInvoice } from "@/lib/domains/billing/invoices"
import { getEmployee } from "@/lib/domains/hr/employees"
import { recordPayment } from "@/lib/domains/billing/payments"
import { generateSystemCharge } from "@/lib/domains/billing/charges"
import { openSession as openCashierSession } from "@/lib/domains/billing/cashier"
import { updateRolePermissions } from "@/lib/domains/identity/roles"
import type { SessionContext } from "@/lib/auth/session"

const TIMEOUT = 60000

/**
 * P4.3 — targeted tests for the security invariants this batch actually
 * fixed or newly proved. Deliberately does NOT re-test what's already
 * covered elsewhere: same-org cross-branch isolation is
 * `test/integration/branch-isolation.test.ts`'s own job; cross-org role/
 * branch assignment and "last active administrator" protection are
 * `p3-12-admin-settings-role-aware-navigation.test.ts`'s; the cron
 * endpoint's 503/401/200 states are P4.1's. See
 * P4_3_PRODUCTION_SECURITY_HARDENING_REPORT.md's Attack Surface Traced
 * section for the full list of what was re-verified by inspection instead
 * of a new test here, and why.
 */
describe("P4.3 §9: IP-based login rate limiting", () => {
  const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}` // TEST-NET-3, never a real client

  afterAll(async () => {
    await db.loginHistory.deleteMany({ where: { ip } })
  })

  it("allows attempts under the threshold, then throttles once it's crossed — and the throttled response never reveals account existence", async () => {
    // checkIpRateLimit counts failures recorded so far, BEFORE this
    // request's own outcome is recorded — so the 20th attempt itself still
    // sees only 19 prior failures (not throttled yet, and becomes the 20th
    // recorded failure); the 21st is the first to see 20 prior failures and
    // gets throttled. Loop 20 times to reach that recorded count.
    for (let i = 0; i < 20; i++) {
      const result = await login("nobody@nowhere.test", "wrong", { ip, userAgent: "vitest" })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe("Invalid email or password.")
    }

    // The 21st+ attempt from the same IP is throttled — a distinct message,
    // but one that says nothing about whether "nobody@nowhere.test" (or any
    // other email tried from this IP) is a real account.
    const throttled = await login("nobody@nowhere.test", "wrong", { ip, userAgent: "vitest" })
    expect(throttled.ok).toBe(false)
    if (!throttled.ok) expect(throttled.error).toMatch(/too many attempts/i)

    // Throttling is IP-scoped, not account-scoped — even a DIFFERENT,
    // real-looking email from the SAME throttled IP is blocked identically.
    const alsoThrottled = await login("admin@avant.local", "ChangeMe123!", { ip, userAgent: "vitest" })
    expect(alsoThrottled.ok).toBe(false)
    if (!alsoThrottled.ok) expect(alsoThrottled.error).toMatch(/too many attempts/i)
  }, TIMEOUT)

  it("checkIpRateLimit never throttles when ip is unknown (null) — the per-account lockout is the only defense in that case, not a crash", async () => {
    const result = await checkIpRateLimit("staff", null)
    expect(result.throttled).toBe(false)
  })

  it("staff and portal channels are throttled independently — a throttled staff IP doesn't block portal login from the same IP", async () => {
    const freshIp = `203.0.113.${Math.floor(Math.random() * 55) + 150}`
    for (let i = 0; i < 20; i++) {
      await login("nobody@nowhere.test", "wrong", { ip: freshIp, userAgent: "vitest" })
    }
    const staffResult = await login("nobody@nowhere.test", "wrong", { ip: freshIp, userAgent: "vitest" })
    expect(staffResult.ok).toBe(false)
    if (!staffResult.ok) expect(staffResult.error).toMatch(/too many attempts/i)

    const portalResult = await checkIpRateLimit("portal", freshIp)
    expect(portalResult.throttled).toBe(false)

    await db.loginHistory.deleteMany({ where: { ip: freshIp } })
  }, TIMEOUT)
})

describe("P4.3 §44: open redirect guard (safeInternalRedirectPath)", () => {
  it("accepts a genuine internal path", () => {
    expect(safeInternalRedirectPath("/dashboard")).toBe("/dashboard")
    expect(safeInternalRedirectPath("/patients/123")).toBe("/patients/123")
  })

  it("rejects a protocol-relative URL (the classic '//evil.example' bypass)", () => {
    expect(safeInternalRedirectPath("//evil.example")).toBeNull()
    expect(safeInternalRedirectPath("//evil.example/phish")).toBeNull()
  })

  it("rejects a backslash-leading path (browser-normalization bypass attempt)", () => {
    expect(safeInternalRedirectPath("/\\evil.example")).toBeNull()
  })

  it("rejects a full external URL", () => {
    expect(safeInternalRedirectPath("https://evil.example")).toBeNull()
    expect(safeInternalRedirectPath("http://evil.example")).toBeNull()
  })

  it("rejects empty/missing input", () => {
    expect(safeInternalRedirectPath(undefined)).toBeNull()
    expect(safeInternalRedirectPath(null)).toBeNull()
    expect(safeInternalRedirectPath("")).toBeNull()
  })

  it("rejects a value not starting with '/' at all", () => {
    expect(safeInternalRedirectPath("evil.example")).toBeNull()
  })
})

describe("P4.3 §5/§16/§21: organization suspension is enforced at login AND for an already-issued session", () => {
  let orgId: string
  let userId: string
  let rawToken: string

  beforeAll(async () => {
    const org = await db.organization.create({ data: { legalName: "P4.3 Suspend Org", displayName: "P4.3 Suspend Org" } })
    orgId = org.id
    const user = await db.user.create({
      data: { organizationId: orgId, email: `p43-suspend-${Date.now()}@test.local`, firstName: "P43", lastName: "Suspend", passwordHash: await hashPassword("correct-horse-battery") },
    })
    userId = user.id
    rawToken = await createSession({ userId })
  }, TIMEOUT)

  afterAll(async () => {
    await db.session.deleteMany({ where: { userId } })
    await db.user.deleteMany({ where: { id: userId } })
    await db.organization.deleteMany({ where: { id: orgId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("a valid, unexpired, unrevoked session resolves normally while the organization is active", async () => {
    const session = await getSessionContext(rawToken)
    expect(session).not.toBeNull()
  })

  it("suspending the organization immediately invalidates the existing session — no logout/login required", async () => {
    await db.organization.update({ where: { id: orgId }, data: { status: "suspended" } })
    const session = await getSessionContext(rawToken)
    expect(session).toBeNull()
  })

  it("login() also rejects a suspended organization's user with a clear, non-account-existence-revealing-beyond-suspension message", async () => {
    const result = await login((await db.user.findUniqueOrThrow({ where: { id: userId } })).email, "correct-horse-battery", { ip: null, userAgent: "vitest" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/suspended/i)
  })

  it("reactivating the organization lifts the suspension check specifically (not just some other rejection)", async () => {
    await db.organization.update({ where: { id: orgId }, data: { status: "active" } })
    const email = (await db.user.findUniqueOrThrow({ where: { id: userId } })).email
    // A deliberately WRONG password: this reaches (and passes) the
    // organization-status check, then fails at password verification
    // instead — proving the suspension check specifically no longer fires,
    // without needing the full success path (which calls setSessionCookie,
    // requiring a real Next.js request scope `login()` doesn't have here —
    // no test in this codebase calls the full success path of login()
    // directly for exactly that reason; every other test hand-builds a
    // SessionContext instead, see this file's own sibling describe blocks).
    const result = await login(email, "definitely-the-wrong-password", { ip: null, userAgent: "vitest" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("Invalid email or password.") // not the suspension message
    const historyRow = await db.loginHistory.findFirst({ where: { emailAttempted: email }, orderBy: { createdAt: "desc" } })
    expect(historyRow?.reason).toBe("bad_password") // proves it passed the suspension check to get here
  }, TIMEOUT)
})

describe("P4.3 §5/§16: portal organization suspension mirrors the staff fix", () => {
  let orgId: string
  let patientId: string
  let accountId: string
  let rawToken: string

  beforeAll(async () => {
    const org = await db.organization.create({ data: { legalName: "P4.3 Portal Suspend Org", displayName: "P4.3 Portal Suspend Org" } })
    orgId = org.id
    const branch = await db.branch.create({ data: { organizationId: orgId, name: "P4.3 Branch", code: `P43PB-${Date.now()}`, timezone: "UTC" } })
    const patient = await db.patient.create({
      data: { organizationId: orgId, registrationBranchId: branch.id, mrn: `P43-${Date.now()}`, firstName: "Portal", lastName: "Patient", dob: new Date("1990-01-01"), gender: "unknown", mobile: `P43M${Date.now()}` },
    })
    patientId = patient.id
    const account = await db.patientPortalAccount.create({
      data: { organizationId: orgId, patientId: patient.id, email: `p43-portal-${Date.now()}@test.local`, passwordHash: await hashPassword("correct-horse-battery") },
    })
    accountId = account.id
    const { createPortalSession } = await import("@/lib/auth/portal-session")
    rawToken = await createPortalSession({ portalAccountId: accountId })
  }, TIMEOUT)

  afterAll(async () => {
    await db.patientPortalSession.deleteMany({ where: { portalAccountId: accountId } })
    await db.patientPortalAccount.deleteMany({ where: { id: accountId } })
    await db.patient.deleteMany({ where: { id: patientId } })
    await db.branch.deleteMany({ where: { organizationId: orgId } })
    await db.organization.deleteMany({ where: { id: orgId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("suspending the organization immediately invalidates the existing portal session", async () => {
    expect(await getPortalSessionContext(rawToken)).not.toBeNull()
    await db.organization.update({ where: { id: orgId }, data: { status: "suspended" } })
    expect(await getPortalSessionContext(rawToken)).toBeNull()
    await db.organization.update({ where: { id: orgId }, data: { status: "active" } })
  }, TIMEOUT)

  it("portalLogin() writes to LoginHistory with channel 'portal' and rejects a suspended org", async () => {
    await db.organization.update({ where: { id: orgId }, data: { status: "suspended" } })
    const account = await db.patientPortalAccount.findUniqueOrThrow({ where: { id: accountId } })
    const result = await portalLogin(account.email, "correct-horse-battery", { ip: null, userAgent: "vitest" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/suspended/i)

    const historyRow = await db.loginHistory.findFirst({ where: { emailAttempted: account.email, channel: "portal" }, orderBy: { createdAt: "desc" } })
    expect(historyRow?.channel).toBe("portal")
    expect(historyRow?.reason).toBe("organization_suspended")

    await db.organization.update({ where: { id: orgId }, data: { status: "active" } })
  }, TIMEOUT)
})

describe("P4.3 §18/§20/§21: session lifecycle security", () => {
  let userId: string

  beforeAll(async () => {
    const branches = await db.branch.findMany({ take: 1 })
    if (branches.length < 1) throw new Error("Test requires at least 1 seeded branch.")
    const user = await db.user.create({
      data: { organizationId: branches[0].organizationId, email: `p43-lifecycle-${Date.now()}@test.local`, firstName: "P43", lastName: "Lifecycle", passwordHash: "x" },
    })
    userId = user.id
  }, TIMEOUT)

  afterAll(async () => {
    await db.session.deleteMany({ where: { userId } })
    await db.user.deleteMany({ where: { id: userId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("§18: logout (revokeSession) invalidates the session server-side — the raw token cannot resolve a session again", async () => {
    const rawToken = await createSession({ userId })
    expect(await getSessionContext(rawToken)).not.toBeNull()

    const session = await getSessionContext(rawToken)
    await revokeSession(session!.sessionId)

    expect(await getSessionContext(rawToken)).toBeNull()
  }, TIMEOUT)

  it("§20: deactivating the user immediately invalidates their existing session — no logout/login required", async () => {
    const rawToken = await createSession({ userId })
    expect(await getSessionContext(rawToken)).not.toBeNull()

    await db.user.update({ where: { id: userId }, data: { status: "inactive" } })
    expect(await getSessionContext(rawToken)).toBeNull()

    await db.user.update({ where: { id: userId }, data: { status: "active" } })
  }, TIMEOUT)

  it("§17: two separate logins for the same user produce two distinct, independently-revocable session tokens (no fixation/reuse)", async () => {
    const tokenA = await createSession({ userId })
    const tokenB = await createSession({ userId })
    expect(tokenA).not.toBe(tokenB)

    const sessionA = await getSessionContext(tokenA)
    await revokeSession(sessionA!.sessionId)

    expect(await getSessionContext(tokenA)).toBeNull()
    expect(await getSessionContext(tokenB)).not.toBeNull() // revoking one session never touches the other
  }, TIMEOUT)
})

describe("P4.3 §21: role permission changes take effect on the very next request — no stale authorization", () => {
  let organizationId: string
  let userId: string
  let roleId: string
  let permissionId: string

  beforeAll(async () => {
    const branches = await db.branch.findMany({ take: 1 })
    organizationId = branches[0].organizationId
    const permission = await db.permission.findFirstOrThrow({ where: { code: "patient.view" } })
    permissionId = permission.id
    const role = await db.role.create({ data: { organizationId, name: `P4.3 Stale-Auth Role ${Date.now()}` } })
    roleId = role.id
    await db.rolePermission.create({ data: { roleId, permissionId } })
    const user = await db.user.create({
      data: { organizationId, email: `p43-stale-${Date.now()}@test.local`, firstName: "P43", lastName: "Stale", passwordHash: "x" },
    })
    userId = user.id
    await db.userRole.create({ data: { userId, roleId } })
  }, TIMEOUT)

  afterAll(async () => {
    await db.session.deleteMany({ where: { userId } })
    await db.userRole.deleteMany({ where: { userId } })
    await db.user.deleteMany({ where: { id: userId } })
    await db.rolePermission.deleteMany({ where: { roleId } })
    await db.role.deleteMany({ where: { id: roleId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("removing a role's permission is reflected the next time an existing session is resolved — the same DB-backed session, not a new login", async () => {
    const rawToken = await createSession({ userId })
    const before = await getSessionContext(rawToken)
    expect(before?.permissions.has("patient.view")).toBe(true)

    const actorSession: SessionContext = {
      sessionId: "test-p4-3-actor", user: { id: userId, organizationId, email: "x@test.local", firstName: "X", lastName: "Y" },
      activeBranchId: null, branchIds: [], permissions: new Set(["users.manage"]), roleNames: ["Admin"],
    }
    await updateRolePermissions(actorSession, roleId, [])

    const after = await getSessionContext(rawToken)
    expect(after?.permissions.has("patient.view")).toBe(false)
  }, TIMEOUT)
})

describe("P4.3 §26-28: cross-organization IDOR — representative reads across Patient, Invoice, Employee", () => {
  let orgAId: string
  let orgBId: string
  let branchAId: string
  let patientAId: string
  let employeeAId: string
  let invoiceAId: string
  let sessionB: SessionContext

  beforeAll(async () => {
    const orgA = await db.organization.create({ data: { legalName: "P4.3 IDOR Org A", displayName: "P4.3 IDOR Org A" } })
    orgAId = orgA.id
    const orgB = await db.organization.create({ data: { legalName: "P4.3 IDOR Org B", displayName: "P4.3 IDOR Org B" } })
    orgBId = orgB.id
    const branchA = await db.branch.create({ data: { organizationId: orgAId, name: "P4.3 Branch A", code: `P43BA-${Date.now()}`, timezone: "UTC" } })
    branchAId = branchA.id
    const branchB = await db.branch.create({ data: { organizationId: orgBId, name: "P4.3 Branch B", code: `P43BB-${Date.now()}`, timezone: "UTC" } })

    const patientA = await db.patient.create({
      data: { organizationId: orgAId, registrationBranchId: branchAId, mrn: `P43IDORA-${Date.now()}`, firstName: "Org A", lastName: "Patient", dob: new Date("1990-01-01"), gender: "unknown", mobile: `P43IM${Date.now()}` },
    })
    patientAId = patientA.id

    const department = await db.department.create({ data: { branchId: branchAId, name: "P4.3 Dept", code: `P43D-${Date.now()}` } })
    const employeeA = await db.employee.create({
      data: { organizationId: orgAId, branchId: branchAId, departmentId: department.id, employeeNumber: `P43EA-${Date.now()}`, firstName: "Org A", lastName: "Employee", designation: "Test", joiningDate: new Date(), employmentType: "full_time", basicSalary: 1000 },
    })
    employeeAId = employeeA.id

    const userA = await db.user.create({ data: { organizationId: orgAId, email: `p43-idor-a-${Date.now()}@test.local`, firstName: "Org A", lastName: "User", passwordHash: "x" } })
    const cashierReg = await openCashierSession(
      { sessionId: "t", user: { id: userA.id, organizationId: orgAId, email: "x", firstName: "X", lastName: "Y" }, activeBranchId: branchAId, branchIds: [branchAId], permissions: new Set(["cashier.open"]), roleNames: [] },
      { branchId: branchAId, openingCash: 0 }
    )
    const charge = await db.$transaction((tx) =>
      generateSystemCharge(tx, { organizationId: orgAId, branchId: branchAId, patientId: patientAId, sourceType: "other", description: "P4.3 IDOR fixture", quantity: 1, unitPrice: 50 })
    )
    const invoiceSession: SessionContext = { sessionId: "t", user: { id: userA.id, organizationId: orgAId, email: "x", firstName: "X", lastName: "Y" }, activeBranchId: branchAId, branchIds: [branchAId], permissions: new Set(["invoice.create"]), roleNames: [] }
    const invoice = await generateInvoice(invoiceSession, { patientId: patientAId, branchId: branchAId, chargeIds: [charge.id], discountAmount: 0 })
    invoiceAId = invoice.id
    void cashierReg

    const userB = await db.user.create({ data: { organizationId: orgBId, email: `p43-idor-b-${Date.now()}@test.local`, firstName: "Org B", lastName: "User", passwordHash: "x" } })
    sessionB = {
      sessionId: "test-p4-3-org-b", user: { id: userB.id, organizationId: orgBId, email: userB.email, firstName: "Org B", lastName: "User" },
      activeBranchId: branchB.id, branchIds: [branchB.id],
      permissions: new Set(["patient.view", "invoice.view", "employee.view"]), roleNames: ["P4.3 Org B Role"],
    }
  }, TIMEOUT)

  afterAll(async () => {
    // Full, ordered teardown (children before parents) — an incomplete list
    // here doesn't just fail loudly, it leaves an ORPHANED Organization/
    // Branch behind that a LATER, unrelated test file's own
    // `findFirstOrThrow()` (no filter — "grab any branch, there's only one
    // in a real his_test") can then pick up instead of the real seed data,
    // breaking that file in a way that looks nothing like this one's fault.
    // That's a real failure mode this exact test hit during development —
    // see this describe block's own entry in
    // P4_3_PRODUCTION_SECURITY_HARDENING_REPORT.md's Tests Added section.
    await db.paymentAllocation.deleteMany({ where: { invoiceId: invoiceAId } }).catch(() => {})
    await db.invoiceLine.deleteMany({ where: { invoiceId: invoiceAId } }).catch(() => {})
    await db.invoice.deleteMany({ where: { id: invoiceAId } }).catch(() => {})
    await db.charge.deleteMany({ where: { patientId: patientAId } }).catch(() => {})
    await db.cashierSession.deleteMany({ where: { branchId: branchAId } }).catch(() => {})
    // generateInvoice/generateSystemCharge queue OutboxEvent rows that this
    // test never dispatches (it isn't exercising the outbox) — they'd
    // otherwise block the Organization delete below the same way audit_log
    // does.
    await db.outboxEvent.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } }).catch(() => {})
    await db.numberSequence.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } }).catch(() => {})
    await db.employee.deleteMany({ where: { id: employeeAId } }).catch(() => {})
    await db.patient.deleteMany({ where: { id: patientAId } }).catch(() => {})
    await db.user.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } }).catch(() => {})
    await db.department.deleteMany({ where: { branch: { organizationId: orgAId } } }).catch(() => {})
    await db.branch.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } }).catch(() => {})

    // audit_log is insert-only for the restricted runtime role this test
    // file's own `db` singleton connects as (P0-06's own immutability
    // guarantee — UPDATE/DELETE are genuinely revoked, not just
    // discouraged) — deleting these fixture rows to let the Organization
    // delete below succeed needs the owner connection, same pattern
    // test/integration/p3-7-billing-pos-cashier-workflow.test.ts's own
    // afterAll already uses for clinical_access_log.
    const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_DATABASE_URL }) })
    await ownerDb.auditLog.deleteMany({ where: { organizationId: { in: [orgAId, orgBId] } } }).catch(() => {})
    await ownerDb.$disconnect()

    await db.organization.deleteMany({ where: { id: { in: [orgAId, orgBId] } } }).catch(() => {})
    await db.$disconnect()
  }, TIMEOUT)

  it("Organization B cannot read Organization A's Patient by id", async () => {
    await expect(getPatient(sessionB, patientAId)).rejects.toThrow()
  })

  it("Organization B cannot read Organization A's Invoice by id", async () => {
    await expect(getInvoice(sessionB, invoiceAId)).rejects.toThrow()
  })

  it("Organization B cannot read Organization A's Employee by id", async () => {
    await expect(getEmployee(sessionB, employeeAId)).rejects.toThrow()
  })
})

describe("P4.3 §62: financial tampering — client-shaped input cannot set server-computed financial fields", () => {
  let organizationId: string
  let branchId: string
  let patientId: string
  let cashierUserId: string

  beforeAll(async () => {
    const branches = await db.branch.findMany({ take: 1 })
    organizationId = branches[0].organizationId
    branchId = branches[0].id
    const patient = await db.patient.create({
      data: { organizationId, registrationBranchId: branchId, mrn: `P43FIN-${Date.now()}`, firstName: "Financial", lastName: "Tamper", dob: new Date("1990-01-01"), gender: "unknown", mobile: `P43FM${Date.now()}` },
    })
    patientId = patient.id
    const user = await db.user.create({ data: { organizationId, email: `p43-fin-${Date.now()}@test.local`, firstName: "P43", lastName: "Fin", passwordHash: "x" } })
    cashierUserId = user.id
  }, TIMEOUT)

  afterAll(async () => {
    await db.patient.deleteMany({ where: { id: patientId } }).catch(() => {})
    await db.user.deleteMany({ where: { id: cashierUserId } }).catch(() => {})
    await db.$disconnect()
  }, TIMEOUT)

  function session(): SessionContext {
    return {
      sessionId: "test-p4-3-financial", user: { id: cashierUserId, organizationId, email: "x", firstName: "X", lastName: "Y" },
      activeBranchId: branchId, branchIds: [branchId],
      permissions: new Set(["charge.create", "invoice.create", "invoice.view", "payment.create", "cashier.open"]), roleNames: [],
    }
  }

  it("generateInvoice computes totalAmount/subtotal from the Charges themselves — a smuggled extra field on the input object is ignored, not trusted", async () => {
    const charge = await db.$transaction((tx) =>
      generateSystemCharge(tx, { organizationId, branchId, patientId, sourceType: "other", description: "P4.3 tamper fixture", quantity: 1, unitPrice: 77 })
    )
    // Cast past the TypeScript input type to simulate a raw HTTP client
    // sending extra fields the real UI never would — this is exactly the
    // "data: input"-style mass-assignment risk §32/§62 ask to check for.
    const tampered = {
      patientId, branchId, chargeIds: [charge.id], discountAmount: 0,
      totalAmount: 1, paidAmount: 999999, status: "paid", organizationId: "not-my-org",
    } as unknown as Parameters<typeof generateInvoice>[1]

    const invoice = await generateInvoice(session(), tampered)
    // The real charge amount (77), never the smuggled 1/999999/paid/not-my-org.
    expect(Number(invoice.totalAmount)).toBe(77)
    expect(Number(invoice.paidAmount)).toBe(0)
    expect(invoice.status).toBe("issued")
    expect(invoice.organizationId).toBe(organizationId)

    await db.invoiceLine.deleteMany({ where: { invoiceId: invoice.id } })
    await db.invoice.deleteMany({ where: { id: invoice.id } })
    await db.charge.deleteMany({ where: { id: charge.id } })
  }, TIMEOUT)

  it("recordPayment rejects a tender total that exceeds the real outstanding balance — a smuggled 'amount' field cannot overpay/corrupt the balance", async () => {
    const charge = await db.$transaction((tx) =>
      generateSystemCharge(tx, { organizationId, branchId, patientId, sourceType: "other", description: "P4.3 tamper fixture 2", quantity: 1, unitPrice: 40 })
    )
    const invoice = await generateInvoice(session(), { patientId, branchId, chargeIds: [charge.id], discountAmount: 0 })
    const register = await openCashierSession(session(), { branchId, openingCash: 0 })

    await expect(
      recordPayment(session(), { invoiceId: invoice.id, cashierSessionId: register.id, tenders: [{ method: "cash", amount: 999999 }] })
    ).rejects.toThrow(/exceeds the outstanding balance/)

    const reloaded = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
    expect(Number(reloaded.paidAmount)).toBe(0) // the rejected attempt left the real balance untouched

    await db.cashierSession.deleteMany({ where: { id: register.id } }).catch(() => {})
    await db.invoiceLine.deleteMany({ where: { invoiceId: invoice.id } })
    await db.invoice.deleteMany({ where: { id: invoice.id } })
    await db.charge.deleteMany({ where: { id: charge.id } })
  }, TIMEOUT)
})

describe("P4.3 §47: cron endpoint token comparison stays constant-time-safe and correct", () => {
  it("a token of a completely different length is still correctly rejected (the length-mismatch short-circuit doesn't accidentally accept it)", async () => {
    const { GET } = await import("@/app/api/cron/outbox-sweep/route")
    const { NextRequest } = await import("next/server")
    const originalSecret = process.env.CRON_SECRET
    process.env.CRON_SECRET = "a-secret-of-a-particular-length"
    try {
      const request = new NextRequest("http://localhost/api/cron/outbox-sweep", { headers: { authorization: "Bearer short" } })
      const response = await GET(request)
      expect(response.status).toBe(401)
    } finally {
      if (originalSecret === undefined) delete process.env.CRON_SECRET
      else process.env.CRON_SECRET = originalSecret
    }
  })
})

/**
 * Targeted backlog closure, item 11 (P4.3's own documented LOW-severity
 * backlog item): a deactivated ("inactive") account previously returned a
 * distinct "This account is inactive" message before the password was ever
 * checked — enough on its own to let an unauthenticated caller learn a
 * given email belongs to a real, deactivated account. Verifies the staff
 * (`login`) and portal (`portalLogin`) flows both now return the identical
 * generic message for a nonexistent account, a wrong password against a
 * real account, AND an inactive real account — while still recording the
 * real, specific reason internally (LoginHistory) and still genuinely
 * blocking the inactive account from logging in (not weakened).
 */
describe("Targeted backlog closure, item 11: login does not enumerate an inactive account", () => {
  let organizationId: string
  let branchId: string
  let activeUserId: string
  let inactiveUserId: string
  const createdUserIds: string[] = []

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id
    const passwordHash = await hashPassword("Correct-Horse-1")

    const active = await db.user.create({
      data: { organizationId, email: `p11-active-${Date.now()}@test.local`, passwordHash, firstName: "Active", lastName: "User", status: "active" },
    })
    activeUserId = active.id
    createdUserIds.push(active.id)

    const inactive = await db.user.create({
      data: { organizationId, email: `p11-inactive-${Date.now()}@test.local`, passwordHash, firstName: "Inactive", lastName: "User", status: "inactive" },
    })
    inactiveUserId = inactive.id
    createdUserIds.push(inactive.id)
  }, TIMEOUT)

  afterAll(async () => {
    await db.loginHistory.deleteMany({ where: { userId: { in: createdUserIds } } })
    await db.session.deleteMany({ where: { userId: { in: createdUserIds } } })
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } })
    await db.$disconnect()
  }, TIMEOUT)

  it("staff login: nonexistent account, wrong password, and an inactive account all return the identical message", async () => {
    const nonexistent = await login(`p11-nobody-${Date.now()}@test.local`, "whatever", { ip: null, userAgent: "vitest" })
    const inactiveUser = await db.user.findUniqueOrThrow({ where: { id: inactiveUserId } })
    const inactiveAttempt = await login(inactiveUser.email, "Correct-Horse-1", { ip: null, userAgent: "vitest" })
    const activeUser = await db.user.findUniqueOrThrow({ where: { id: activeUserId } })
    const wrongPassword = await login(activeUser.email, "definitely-wrong", { ip: null, userAgent: "vitest" })

    expect(nonexistent.ok).toBe(false)
    expect(inactiveAttempt.ok).toBe(false)
    expect(wrongPassword.ok).toBe(false)
    if (!nonexistent.ok && !inactiveAttempt.ok && !wrongPassword.ok) {
      expect(nonexistent.error).toBe(inactiveAttempt.error)
      expect(wrongPassword.error).toBe(inactiveAttempt.error)
      expect(inactiveAttempt.error).not.toMatch(/inactive/i) // the actual regression this item closes
    }

    // Not weakened: the internal record still distinguishes the real reason,
    // and a correct password against the inactive account still genuinely fails.
    const historyRow = await db.loginHistory.findFirst({ where: { userId: inactiveUserId }, orderBy: { createdAt: "desc" } })
    expect(historyRow?.reason).toBe("inactive")
    expect(historyRow?.success).toBe(false)
  }, TIMEOUT)

  it("staff login: a real, correct password against the inactive account is still genuinely rejected, not silently allowed through", async () => {
    const inactiveUser = await db.user.findUniqueOrThrow({ where: { id: inactiveUserId } })
    const result = await login(inactiveUser.email, "Correct-Horse-1", { ip: null, userAgent: "vitest" })
    expect(result.ok).toBe(false)
  }, TIMEOUT)

  it("portal login: the same normalization applies to the patient portal flow", async () => {
    const passwordHash = await hashPassword("Portal-Correct-1")
    // A dedicated patient, not a shared/seeded one — PatientPortalAccount.patientId
    // is @unique, and reusing an existing patient risks colliding with an
    // account another test or seed fixture already created for it.
    const patient = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchId,
        mrn: `P11PORTAL-${Date.now()}`, firstName: "P11", lastName: "Portal",
        dob: new Date("1990-01-01"), gender: "unknown", mobile: `P11M${Date.now()}`,
      },
    })
    const account = await db.patientPortalAccount.create({
      data: {
        organizationId,
        patientId: patient.id,
        email: `p11-portal-inactive-${Date.now()}@test.local`,
        passwordHash,
        status: "inactive",
      },
    })
    try {
      const nonexistent = await portalLogin(`p11-portal-nobody-${Date.now()}@test.local`, "whatever", { ip: null, userAgent: "vitest" })
      const inactiveAttempt = await portalLogin(account.email, "Portal-Correct-1", { ip: null, userAgent: "vitest" })
      expect(nonexistent.ok).toBe(false)
      expect(inactiveAttempt.ok).toBe(false)
      if (!nonexistent.ok && !inactiveAttempt.ok) {
        expect(nonexistent.error).toBe(inactiveAttempt.error)
        expect(inactiveAttempt.error).not.toMatch(/inactive/i)
      }
      const historyRow = await db.loginHistory.findFirst({ where: { emailAttempted: account.email }, orderBy: { createdAt: "desc" } })
      expect(historyRow?.reason).toBe("inactive")
    } finally {
      await db.loginHistory.deleteMany({ where: { emailAttempted: account.email } })
      await db.patientPortalAccount.delete({ where: { id: account.id } })
      await db.patient.delete({ where: { id: patient.id } })
    }
  }, TIMEOUT)
})
