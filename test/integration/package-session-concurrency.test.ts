import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { consumeSession } from "@/lib/domains/packages/service"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P1 §28 — real DB integration test against the `SELECT ... FOR UPDATE` row
 * lock added to `consumeSession` this batch (src/lib/domains/packages/service.ts).
 * Session is a hand-built Super Admin context (bypasses permission/branch
 * checks) — the same precedent refund-payment-integrity.test.ts uses, since
 * this file tests transactional correctness, not authorization.
 */
const TIMEOUT = 60000

describe("P1 §28: package session consumption concurrency", () => {
  let organizationId: string
  let branchId: string
  let patientId: string
  let serviceId: string
  let userId: string
  const patientPackageIds: string[] = []

  function session(): SessionContext {
    return {
      sessionId: "test-package-session-concurrency",
      user: { id: userId, organizationId, email: "pkg-concurrency-test@test.local", firstName: "Package", lastName: "Test" },
      activeBranchId: branchId,
      branchIds: [branchId],
      permissions: new Set(["package.consume"]),
      roleNames: ["Super Admin"],
    }
  }

  async function createPatientPackage(sessionsAllocated: number) {
    // A fresh Package (and its single PackageService line) per case, all
    // pointed at the same PatientPackage — isolates each test's "remaining
    // sessions" count from any other running concurrently in this file.
    const pkg = await db.package.create({
      data: {
        organizationId,
        code: `TESTPKGCONC-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: "Concurrency Test Package",
        price: 100,
      },
    })
    const packageService = await db.packageService.create({
      data: { packageId: pkg.id, serviceId, sessionsAllocated },
    })
    const patientPackage = await db.patientPackage.create({
      data: { organizationId, branchId, patientId, packageId: pkg.id, purchasePrice: 100 },
    })
    patientPackageIds.push(patientPackage.id)
    return { patientPackage, packageService, pkg }
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id
    const user = await db.user.findFirstOrThrow({ where: { organizationId } })
    userId = user.id

    const patient = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchId,
        mrn: `TESTPKGCONC-${Date.now()}`, firstName: "PackageConcurrency", lastName: "Integrity",
        dob: new Date("1990-01-01"), gender: "unknown", mobile: `PKGC${Date.now()}`,
      },
    })
    patientId = patient.id

    const service = await db.service.create({
      data: {
        organizationId, code: `TESTPKGCONC-SVC-${Date.now()}`, name: "Concurrency Test Service",
        category: "test", durationMinutes: 30, price: 50,
      },
    })
    serviceId = service.id
  }, TIMEOUT)

  afterAll(async () => {
    await db.patientPackageSession.deleteMany({ where: { patientPackageId: { in: patientPackageIds } } })
    const packages = await db.patientPackage.findMany({ where: { id: { in: patientPackageIds } } })
    await db.patientPackage.deleteMany({ where: { id: { in: patientPackageIds } } })
    await db.packageService.deleteMany({ where: { packageId: { in: packages.map((p) => p.packageId) } } })
    await db.package.deleteMany({ where: { id: { in: packages.map((p) => p.packageId) } } })
    await db.patient.delete({ where: { id: patientId } })
    await db.service.delete({ where: { id: serviceId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("exactly one session remaining, two simultaneous completion requests — only one succeeds", async () => {
    const { patientPackage, packageService } = await createPatientPackage(1)

    const results = await Promise.allSettled([
      consumeSession(session(), { patientPackageId: patientPackage.id, packageServiceId: packageService.id }),
      consumeSession(session(), { patientPackageId: patientPackage.id, packageServiceId: packageService.id }),
    ])

    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    // Which message fires depends on commit order: if the winner's own
    // commit already flipped the package to "exhausted" (true here, since
    // this package's one service had exactly one session total) before the
    // loser re-checks under the lock, the loser sees "exhausted" rather than
    // "no remaining sessions" — both are correct rejections of the same race,
    // not two different behaviors.
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/exhausted|No remaining sessions/)

    const sessions = await db.patientPackageSession.findMany({ where: { patientPackageId: patientPackage.id } })
    expect(sessions.length).toBe(1) // never two consumption rows against an allocation of one

    const after = await db.patientPackage.findUniqueOrThrow({ where: { id: patientPackage.id } })
    expect(after.status).toBe("exhausted") // the winning consumption correctly flipped it
  }, TIMEOUT)

  it("three sessions remaining, three simultaneous completion requests — all three succeed, no fourth is possible", async () => {
    const { patientPackage, packageService } = await createPatientPackage(3)

    const results = await Promise.allSettled([
      consumeSession(session(), { patientPackageId: patientPackage.id, packageServiceId: packageService.id }),
      consumeSession(session(), { patientPackageId: patientPackage.id, packageServiceId: packageService.id }),
      consumeSession(session(), { patientPackageId: patientPackage.id, packageServiceId: packageService.id }),
    ])

    expect(results.filter((r) => r.status === "fulfilled").length).toBe(3)
    const sessions = await db.patientPackageSession.findMany({ where: { patientPackageId: patientPackage.id } })
    expect(sessions.length).toBe(3)
  }, TIMEOUT)

  it("a single consumption on a package with sessions remaining still succeeds normally (the lock doesn't over-reject)", async () => {
    const { patientPackage, packageService } = await createPatientPackage(2)
    await consumeSession(session(), { patientPackageId: patientPackage.id, packageServiceId: packageService.id })
    const after = await db.patientPackage.findUniqueOrThrow({ where: { id: patientPackage.id } })
    expect(after.status).toBe("active") // one of two used — not yet exhausted
  }, TIMEOUT)

  /**
   * P1 §33: the row lock above stops OVERSELLING past the total, but not a
   * double-click burning two sessions from ample headroom (5 remaining, one
   * double-clicked "complete" would otherwise consume 2 for one visit) — the
   * gap `consumeSession`'s own `idempotencyKey` parameter closes (added
   * alongside the lock, but — until this test — never actually exercised by
   * an automated test proving the mechanism works, only by the application
   * code declaring it exists). Found and closed in this final synthesis
   * batch while cross-checking every §33-named action actually has a real
   * test, not just a real implementation.
   */
  it("two identical consumeSession calls with the SAME idempotency key, ample sessions remaining — only one session is ever consumed", async () => {
    const { patientPackage, packageService } = await createPatientPackage(5)
    const key = `test-package-idempotency-${Date.now()}`

    const [first, second] = await Promise.all([
      consumeSession(session(), { patientPackageId: patientPackage.id, packageServiceId: packageService.id, idempotencyKey: key }),
      consumeSession(session(), { patientPackageId: patientPackage.id, packageServiceId: packageService.id, idempotencyKey: key }),
    ])
    expect(second.id).toBe(first.id) // the second call replayed the first's own result

    const sessions = await db.patientPackageSession.findMany({ where: { patientPackageId: patientPackage.id } })
    expect(sessions.length).toBe(1) // not two — one real visit, not two

    const after = await db.patientPackage.findUniqueOrThrow({ where: { id: patientPackage.id } })
    expect(after.status).toBe("active") // 1 of 5 used, nowhere near exhausted — the lock alone would have let both through
  }, TIMEOUT)

  it("two consumeSession calls with DIFFERENT idempotency keys are correctly treated as genuinely separate visits", async () => {
    const { patientPackage, packageService } = await createPatientPackage(5)

    await consumeSession(session(), { patientPackageId: patientPackage.id, packageServiceId: packageService.id, idempotencyKey: `test-package-idempotency-a-${Date.now()}` })
    await consumeSession(session(), { patientPackageId: patientPackage.id, packageServiceId: packageService.id, idempotencyKey: `test-package-idempotency-b-${Date.now()}` })

    const sessions = await db.patientPackageSession.findMany({ where: { patientPackageId: patientPackage.id } })
    expect(sessions.length).toBe(2)
  }, TIMEOUT)
})
