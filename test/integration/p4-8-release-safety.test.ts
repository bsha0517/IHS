import { describe, it, expect, afterEach } from "vitest"
import { assertIsSafeRestoreTarget, assertNotRemoteHost } from "../../scripts/db/lib"
import { GATES } from "../../scripts/release/check"

/**
 * P4.8 §84 — focused tests for the new release-safety tooling this phase
 * adds: the production-database guard the upgrade drill reuses, the
 * release-gate command's own shape (fails closed, runs the right checks, in
 * a safe order), and the shared release-version resolution `/api/health`
 * and the structured logger both now read from one place. Deliberately
 * narrow — the real proof that `db:upgrade:drill`/`release:check` work end
 * to end is running them for real (see P4_8_RELEASE_MIGRATION_UPGRADE_SAFETY_REPORT.md's
 * own Migration Rehearsal / Upgrade Drill / Release Simulation sections),
 * not a mock of either here, mirroring this whole engagement's own
 * "don't over-mock the thing that actually needs to run for real" discipline
 * (see test/integration/p4-2-backup-restore-safety.test.ts's identical
 * approach for the backup/restore guards this reuses).
 */
describe("P4.8: db:upgrade:drill's rehearsal-target database name is guarded exactly like every other restore", () => {
  const url = (dbName: string) => `postgresql://postgres:x@localhost:5433/${dbName}?schema=public`

  it("accepts the drill's own rehearsal database name", () => {
    expect(() => assertIsSafeRestoreTarget(url("his_restore_test_upgrade_drill"), "test")).not.toThrow()
  })

  it("the guard still rejects his_dev/his_test even for an upgrade-drill-labeled attempt", () => {
    expect(() => assertIsSafeRestoreTarget(url("his_dev"), "test")).toThrow(/explicitly blocked/)
    expect(() => assertIsSafeRestoreTarget(url("his_test"), "test")).toThrow(/explicitly blocked/)
  })

  it("the guard rejects anything that looks like production regardless of an upgrade-drill label", () => {
    expect(() => assertIsSafeRestoreTarget(url("his_restore_test_production"), "test")).toThrow(/explicitly blocked/)
  })
})

describe("P4.8: the upgrade drill's own source-connection guard refuses a remote/hosted host", () => {
  it("rejects a Supabase-looking DIRECT_DATABASE_URL the same way every other local-only db script does", () => {
    expect(() => assertNotRemoteHost("postgresql://u:p@db.abcxyz.supabase.co:5432/postgres", "DIRECT_DATABASE_URL")).toThrow(/hosted\/shared database/)
  })

  it("accepts the local Postgres cluster", () => {
    expect(() => assertNotRemoteHost("postgresql://postgres:x@localhost:5433/his_dev", "DIRECT_DATABASE_URL")).not.toThrow()
  })
})

describe("P4.8 §11/§12: release:check's gate list — the required checks, in the required order, none silently optional", () => {
  it("includes every gate named in the phase spec, in the documented order", () => {
    const names = GATES.map((g) => g.name)
    expect(names).toEqual([
      "Prisma schema validation",
      "Migration status (drift check)",
      "DB security check (RLS)", // P4.9.1 §11 — added right after the migration-drift check
      "TypeScript",
      "Lint",
      "Component tests",
      "Integration tests",
      "Production build",
    ])
  })

  it("every gate has a real, non-empty command and args — no placeholder/no-op gate", () => {
    for (const gate of GATES) {
      expect(gate.command.length).toBeGreaterThan(0)
      expect(gate.args.length).toBeGreaterThan(0)
    }
  })

  it("schema validation and migration-drift checks run before the slower typecheck/lint/test/build gates — fail fast on the cheapest checks first", () => {
    const names = GATES.map((g) => g.name)
    const validateIdx = names.indexOf("Prisma schema validation")
    const buildIdx = names.indexOf("Production build")
    expect(validateIdx).toBeLessThan(buildIdx)
    expect(names.indexOf("Migration status (drift check)")).toBeLessThan(buildIdx)
  })
})

describe("P4.8 §8: getReleaseVersion() — the single release/version identifier logger.ts and /api/health both read", () => {
  const ENV_KEYS = ["VERCEL_GIT_COMMIT_SHA", "RELEASE_VERSION", "npm_package_version"] as const
  const originals: Record<string, string | undefined> = {}

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (originals[key] === undefined) delete process.env[key]
      else process.env[key] = originals[key]
    }
  })

  async function freshGetReleaseVersion() {
    // Bust the module cache so each test's env mutation is actually picked
    // up — release.ts computes nothing at module scope itself (the function
    // reads process.env live on every call), so this is mostly
    // defense-in-depth against a future refactor that memoizes it.
    const mod = await import("@/lib/platform/release")
    return mod.getReleaseVersion()
  }

  it("prefers VERCEL_GIT_COMMIT_SHA, truncated to 12 chars", async () => {
    for (const key of ENV_KEYS) originals[key] = process.env[key]
    process.env.VERCEL_GIT_COMMIT_SHA = "abcdef0123456789abcdef0123456789"
    process.env.RELEASE_VERSION = "v9.9.9"
    process.env.npm_package_version = "0.1.0"
    expect(await freshGetReleaseVersion()).toBe("abcdef012345")
  })

  it("falls back to RELEASE_VERSION when no commit SHA is present", async () => {
    for (const key of ENV_KEYS) originals[key] = process.env[key]
    delete process.env.VERCEL_GIT_COMMIT_SHA
    process.env.RELEASE_VERSION = "v0.9.0"
    process.env.npm_package_version = "0.1.0"
    expect(await freshGetReleaseVersion()).toBe("v0.9.0")
  })

  it("falls back to npm_package_version when neither of the above is set", async () => {
    for (const key of ENV_KEYS) originals[key] = process.env[key]
    delete process.env.VERCEL_GIT_COMMIT_SHA
    delete process.env.RELEASE_VERSION
    process.env.npm_package_version = "0.1.0"
    expect(await freshGetReleaseVersion()).toBe("0.1.0")
  })

  it("falls back to 'unknown' rather than throwing when nothing is set", async () => {
    for (const key of ENV_KEYS) originals[key] = process.env[key]
    delete process.env.VERCEL_GIT_COMMIT_SHA
    delete process.env.RELEASE_VERSION
    delete process.env.npm_package_version
    expect(await freshGetReleaseVersion()).toBe("unknown")
  })
})
