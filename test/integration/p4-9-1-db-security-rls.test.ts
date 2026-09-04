import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { Client } from "pg"
import { db } from "@/lib/db"
import { applySecurity, checkSecurity, deriveRuntimeRoleName } from "../../scripts/db/security"

/**
 * P4.9.1 Issue A: Row Level Security provisioning must be reproducible from
 * source control, not a one-off manual procedure against the hosted
 * database (which is what actually happened during P4.9 — see
 * P4_9_1_COMMERCIAL_READINESS_CORRECTIONS_REPORT.md). This file exercises
 * the real scripts/db/security.ts functions (the same ones `npm run
 * db:security:apply`/`db:security:check` call) against the local `his_test`
 * database — never a hardcoded/fabricated table list, the actual dynamic
 * enumeration in prisma/db-setup/apply-rls.sql.
 *
 * `his_test` already has this applied once by `db:test:setup` (P4.9.1 wired
 * `applySecurity` into setup-database.ts so local dev/test mirrors
 * production's security posture, not a divergent easier one) — every test
 * below re-applies/re-checks explicitly anyway, both to verify the
 * functions themselves and to prove idempotency (section 12).
 */
describe("P4.9.1: Row Level Security provisioning (scripts/db/security.ts)", () => {
  const directUrl = process.env.DIRECT_DATABASE_URL!
  const runtimeUrl = process.env.DATABASE_URL!

  it("deriveRuntimeRoleName reads the actual role name out of the connection string, not a hardcoded value", () => {
    expect(deriveRuntimeRoleName(runtimeUrl)).toBe("his_app_runtime")
    expect(deriveRuntimeRoleName("postgresql://avant_app_runtime:x@host:5432/postgres")).toBe("avant_app_runtime")
  })

  it("applySecurity is idempotent — running it twice in a row does not throw", async () => {
    await expect(applySecurity({ directUrl, runtimeUrl, label: "p4-9-1-test" })).resolves.not.toThrow()
    await expect(applySecurity({ directUrl, runtimeUrl, label: "p4-9-1-test" })).resolves.not.toThrow()
  }, 30000)

  it("checkSecurity reports every public-schema table as RLS-enabled with the expected runtime-role policy", async () => {
    const result = await checkSecurity({ directUrl, runtimeUrl, label: "p4-9-1-test" })
    expect(result.tablesChecked).toBeGreaterThan(50) // sanity: this really did enumerate the real schema, not an empty/mocked one
    expect(result.tablesWithoutRls).toEqual([])
    expect(result.tablesWithoutPolicy).toEqual([])
    expect(result.ok).toBe(true)
  }, 20000)

  it("checkSecurity correctly reports a table as unsafe if RLS is disabled on it, and reports safe again once re-applied", async () => {
    const owner = new Client({ connectionString: directUrl })
    await owner.connect()
    try {
      // A real table, temporarily de-protected — proves checkSecurity
      // actually looks at live state rather than trusting the last
      // successful apply.
      await owner.query('ALTER TABLE public."setting" DISABLE ROW LEVEL SECURITY')
      const unsafe = await checkSecurity({ directUrl, runtimeUrl, label: "p4-9-1-test" })
      expect(unsafe.ok).toBe(false)
      expect(unsafe.tablesWithoutRls).toContain("setting")
    } finally {
      await owner.end()
    }

    // Re-running the apply script must heal this without any manual
    // intervention — exactly the "future table"/drift scenario this
    // mechanism exists to close.
    await applySecurity({ directUrl, runtimeUrl, label: "p4-9-1-test" })
    const healed = await checkSecurity({ directUrl, runtimeUrl, label: "p4-9-1-test" })
    expect(healed.ok).toBe(true)
  }, 30000)

  describe("policy scoping — the runtime role works normally; an unprivileged role (standing in for Supabase's anon/authenticated) does not get blanket access", () => {
    const simRoleName = "p49_1_anon_sim"
    const simPassword = "p49-1-anon-sim-local-only"
    let simUrl: string

    beforeAll(async () => {
      const owner = new Client({ connectionString: directUrl })
      await owner.connect()
      try {
        // A throwaway role with genuine table-level SELECT — the point is
        // that RLS denies it anyway with no matching policy, the same
        // mechanism that protects the hosted database from Supabase's own
        // `anon`/`authenticated` API roles (section 6/30): a table-level
        // GRANT alone is not sufficient once RLS is enabled.
        await owner.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()`, [simRoleName])
        await owner.query(`DROP ROLE IF EXISTS ${simRoleName}`)
        await owner.query(`CREATE ROLE ${simRoleName} WITH LOGIN PASSWORD '${simPassword}'`)
        await owner.query(`GRANT CONNECT ON DATABASE his_test TO ${simRoleName}`)
        await owner.query(`GRANT USAGE ON SCHEMA public TO ${simRoleName}`)
        await owner.query(`GRANT SELECT ON public.organization TO ${simRoleName}`)
      } finally {
        await owner.end()
      }
      const parsed = new URL(directUrl)
      parsed.username = simRoleName
      parsed.password = simPassword
      simUrl = parsed.toString()
    }, 20000)

    afterAll(async () => {
      const owner = new Client({ connectionString: directUrl })
      await owner.connect()
      try {
        // Force-close any lingering backend still connected as this role
        // first — a role cannot be dropped while a session is open under
        // it, and pg's own connection teardown in the test above is
        // asynchronous relative to when this runs.
        await owner.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()`, [simRoleName])
        await owner.query(`REVOKE SELECT ON public.organization FROM ${simRoleName}`)
        await owner.query(`REVOKE USAGE ON SCHEMA public FROM ${simRoleName}`)
        await owner.query(`REVOKE CONNECT ON DATABASE his_test FROM ${simRoleName}`)
        await owner.query(`DROP ROLE IF EXISTS ${simRoleName}`)
      } finally {
        await owner.end()
      }
    }, 20000)

    it("the simulated anon-equivalent role, despite a real table-level SELECT grant, reads zero rows under RLS (no policy applies to it)", async () => {
      const client = new Client({ connectionString: simUrl })
      await client.connect()
      try {
        const { rows } = await client.query('SELECT * FROM public."organization"')
        expect(rows).toHaveLength(0) // organization has at least 1 real row (owner-verified below) — RLS, not an empty table, is why this role sees none
      } finally {
        await client.end()
      }
      const owner = new Client({ connectionString: directUrl })
      await owner.connect()
      try {
        const { rows: ownerRows } = await owner.query('SELECT * FROM public."organization"')
        expect(ownerRows.length).toBeGreaterThan(0) // the table genuinely has data; the role above just can't see it
      } finally {
        await owner.end()
      }
    }, 20000)

    it("the real application runtime role (his_app_runtime) still has full normal access under RLS — the policy scoped to it works", async () => {
      const branch = await db.branch.findFirstOrThrow()
      expect(branch.id).toBeTruthy()
      const updated = await db.branch.update({ where: { id: branch.id }, data: { name: branch.name } })
      expect(updated.id).toBe(branch.id)
    }, 20000)
  })

  it("audit_log/clinical_access_log remain immutable to the runtime role with RLS enabled — RLS does not weaken the P0-06 GRANT/REVOKE layer", async () => {
    // Re-confirms test/integration/audit-log-immutability.test.ts's own
    // guarantee specifically under this phase's change (RLS now enabled) —
    // the two enforcement layers (table-level GRANT/REVOKE and row-level
    // RLS) are independent; a permissive RLS policy must not accidentally
    // resurrect access the GRANT layer already revoked.
    const organizationId = (await db.organization.findFirstOrThrow()).id
    const created = await db.auditLog.create({
      data: { organizationId, userId: null, action: "test", entityType: "test", entityId: "p4-9-1-rls-audit-test" },
    })
    await expect(db.$executeRawUnsafe(`UPDATE "audit_log" SET action = 'tampered' WHERE id = '${created.id}'`)).rejects.toThrow()
    await expect(db.$executeRawUnsafe(`DELETE FROM "audit_log" WHERE id = '${created.id}'`)).rejects.toThrow()

    const user = await db.user.findFirstOrThrow({ where: { organizationId } })
    const patient = await db.patient.findFirstOrThrow({ where: { organizationId } })
    const clinicalLog = await db.clinicalAccessLog.create({
      data: { organizationId, userId: user.id, patientId: patient.id, resourceType: "test", action: "view" },
    })
    await expect(db.$executeRawUnsafe(`UPDATE "clinical_access_log" SET action = 'tampered' WHERE id = '${clinicalLog.id}'`)).rejects.toThrow()
    await expect(db.$executeRawUnsafe(`DELETE FROM "clinical_access_log" WHERE id = '${clinicalLog.id}'`)).rejects.toThrow()

    // Cleanup via the owner connection — same reasoning as
    // audit-log-immutability.test.ts: the runtime role genuinely cannot do
    // this itself, which is the property under test.
    const { PrismaClient } = await import("@/generated/prisma/client")
    const { PrismaPg } = await import("@prisma/adapter-pg")
    const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: directUrl }) })
    await ownerDb.auditLog.delete({ where: { id: created.id } }).catch(() => {})
    await ownerDb.clinicalAccessLog.delete({ where: { id: clinicalLog.id } }).catch(() => {})
    await ownerDb.$disconnect()
  }, 30000)

  it("a real duplicate-key unique-constraint violation on idempotency_key is still correctly detected as an idempotency conflict with RLS enabled", async () => {
    // Regression guard for a real bug this batch's own RLS work introduced
    // and fixed: @prisma/adapter-pg stops populating
    // `error.meta.driverAdapterError.cause.constraint.fields` for a unique
    // violation the moment RLS is enabled on the violated table (empirically
    // verified, not theoretical) — which silently broke
    // isIdempotencyKeyConflict's old detection and, with it, duplicate-
    // request protection on charges, payments, package sessions, goods
    // receipts, and supplier invoices. isIdempotencyKeyConflict now matches
    // on `error.meta.modelName` instead, which this test proves survives
    // RLS being enabled (his_test has it enabled via db:test:setup as of
    // this same phase).
    const { isIdempotencyKeyConflict } = await import("@/lib/platform/idempotency")
    const organizationId = (await db.organization.findFirstOrThrow()).id
    const key = `p4-9-1-idem-regression-${Date.now()}`
    await db.idempotencyKey.create({ data: { organizationId, scope: "p4-9-1-regression-test", key } })
    let caught: unknown
    try {
      await db.idempotencyKey.create({ data: { organizationId, scope: "p4-9-1-regression-test", key } })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeDefined()
    expect(isIdempotencyKeyConflict(caught)).toBe(true)
    await db.idempotencyKey.deleteMany({ where: { organizationId, scope: "p4-9-1-regression-test" } })
  }, 15000)

  it("applySecurity refuses a pooled connection string for the owner/direct connection", async () => {
    await expect(
      applySecurity({ directUrl: "postgresql://x:y@host:6543/db?pgbouncer=true", runtimeUrl, label: "p4-9-1-test" })
    ).rejects.toThrow(/pooled/i)
  })
})
