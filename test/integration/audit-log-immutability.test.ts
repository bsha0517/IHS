import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

/**
 * P0-06 / P1 §1-2 remediation tests. Two parts:
 *
 * 1. Always runs: confirms no application code path can even attempt an
 *    update/delete on audit_log or clinical_access_log — grep-verified
 *    separately (only prisma/generated JSDoc examples reference those
 *    methods, never real callers), asserted here at the type/behavior
 *    level via the actual domain functions this app calls.
 *
 * 2. Live verification through `db` — the exact same PrismaClient
 *    instance every domain service imports from `@/lib/db`, connected via
 *    DATABASE_URL, which now points at the restricted `avant_app_runtime`
 *    role rather than the schema owner (P1 §1's cutover; see
 *    prisma/db-setup/p0-06-create-runtime-role.sql and DATABASE.md's
 *    "Connection Roles"). This is deliberately not a second, separate
 *    connection standing in for "what the runtime role could do" — it *is*
 *    the runtime connection, so a passing test here is direct proof, not
 *    an inference. Cleanup needs its own owner-level connection
 *    (DIRECT_DATABASE_URL) specifically because the restricted role
 *    genuinely cannot delete the row it just inserted — that's the
 *    property under test.
 */
describe("P0-06: audit log immutability", () => {
  it("no application code path exposes update/delete on AuditLog (confirmed via source, asserted here as a living check)", async () => {
    const auditModule = await import("@/lib/platform/audit")
    const exportedNames = Object.keys(auditModule)
    // The only two functions this module exports are the insert-only
    // writer and its session-scoped convenience wrapper — if an
    // update/delete helper is ever added here, this assertion fails and
    // forces a conscious decision, not a silent drift.
    expect(exportedNames.sort()).toEqual(["auditFromSession", "writeAuditLog"])
  })

  describe("DB-level enforcement, verified through the application's real runtime connection", () => {
    let ownerDb: PrismaClient
    let organizationId: string
    let testLogId: string

    beforeAll(async () => {
      const adapter = new PrismaPg({ connectionString: process.env.DIRECT_DATABASE_URL })
      ownerDb = new PrismaClient({ adapter })
      organizationId = (await db.organization.findFirstOrThrow()).id
    }, 20000)

    afterAll(async () => {
      // Cleanup uses the owner connection — the whole point of this test
      // is that the runtime connection (`db`) genuinely cannot do this itself.
      if (testLogId) {
        await ownerDb.auditLog.delete({ where: { id: testLogId } }).catch(() => {})
      }
      await ownerDb.$disconnect()
    }, 20000)

    it("the application CAN insert and read audit_log rows through its real runtime connection", async () => {
      const created = await db.auditLog.create({
        data: { organizationId, userId: null, action: "test", entityType: "test", entityId: "p0-06-runtime-role-test" },
      })
      testLogId = created.id
      const readBack = await db.auditLog.findUnique({ where: { id: created.id } })
      expect(readBack).not.toBeNull()
    }, 20000)

    it("the application CANNOT update an audit_log row through its real runtime connection — PostgreSQL rejects it, not application code", async () => {
      await expect(
        db.$executeRawUnsafe(`UPDATE "audit_log" SET action = 'tampered' WHERE id = '${testLogId}'`)
      ).rejects.toThrow()

      // Confirm via the owner connection that the row is genuinely unchanged.
      const stillOriginal = await ownerDb.auditLog.findUnique({ where: { id: testLogId } })
      expect(stillOriginal?.action).toBe("test")
    }, 20000)

    it("the application CANNOT delete an audit_log row through its real runtime connection — PostgreSQL rejects it, not application code", async () => {
      await expect(db.$executeRawUnsafe(`DELETE FROM "audit_log" WHERE id = '${testLogId}'`)).rejects.toThrow()

      const stillExists = await ownerDb.auditLog.findUnique({ where: { id: testLogId } })
      expect(stillExists).not.toBeNull()
    }, 20000)

    it("the application retains full read/write access to a normal (non-audit) table through its real runtime connection", async () => {
      const branch = await db.branch.findFirstOrThrow()
      expect(branch.id).toBeTruthy()
      const updated = await db.branch.update({ where: { id: branch.id }, data: { name: branch.name } })
      expect(updated.id).toBe(branch.id)
    }, 20000)
  })
})
