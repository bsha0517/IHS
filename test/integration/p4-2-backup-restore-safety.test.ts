import { describe, it, expect } from "vitest"
import { assertIsSafeRestoreTarget, assertNotPooledConnection, assertNotRemoteHost, requireEnv } from "../../scripts/db/lib"
import { runBackup, timestampForFilename } from "../../scripts/db/backup"

/**
 * P4.2 §55 — targeted tests for the backup/restore safety guards
 * (scripts/db/lib.ts, scripts/db/backup.ts). Deliberately narrow: these
 * exercise the guard logic in isolation (no real pg_dump/pg_restore
 * process, no real database), because the actual, mandatory local
 * backup/restore drill (npm run db:dr:drill — see
 * P4_2_DATABASE_RELIABILITY_BACKUP_RESTORE_DISASTER_RECOVERY_REPORT.md's
 * Drill Report section for the real run's results) is what proves the real
 * pg_dump/pg_restore path itself, not a mock of it — §51's own instruction
 * against over-mocking the one thing that actually needs to be exercised
 * for real.
 */
describe("P4.2 §14: assertIsSafeRestoreTarget — fail-closed restore-target guard", () => {
  const url = (dbName: string) => `postgresql://postgres:x@localhost:5433/${dbName}?schema=public`

  it("accepts the bare 'his_restore_test' name", () => {
    expect(() => assertIsSafeRestoreTarget(url("his_restore_test"), "test")).not.toThrow()
  })

  it("accepts a suffixed 'his_restore_test_...' name", () => {
    expect(() => assertIsSafeRestoreTarget(url("his_restore_test_20260901_p42drill"), "test")).not.toThrow()
  })

  it("rejects 'his_dev'", () => {
    expect(() => assertIsSafeRestoreTarget(url("his_dev"), "test")).toThrow(/explicitly blocked/)
  })

  it("rejects 'his_test'", () => {
    expect(() => assertIsSafeRestoreTarget(url("his_test"), "test")).toThrow(/explicitly blocked/)
  })

  it("rejects the bare maintenance database 'postgres'", () => {
    expect(() => assertIsSafeRestoreTarget(url("postgres"), "test")).toThrow(/explicitly blocked/)
  })

  it("rejects a name that doesn't match the required pattern at all", () => {
    expect(() => assertIsSafeRestoreTarget(url("some_random_database"), "test")).toThrow(/naming pattern/)
  })

  it("rejects a name containing 'prod' even though it otherwise matches the safe prefix — belt-and-suspenders", () => {
    expect(() => assertIsSafeRestoreTarget(url("his_restore_test_production"), "test")).toThrow(/explicitly blocked/)
  })

  it("has no override mechanism — an env var of the same shape as other guards' overrides does not bypass it", () => {
    const originalEnv = process.env.DR_RESTORE_FORCE_UNSAFE_TARGET
    process.env.DR_RESTORE_FORCE_UNSAFE_TARGET = "I_UNDERSTAND"
    try {
      expect(() => assertIsSafeRestoreTarget(url("his_dev"), "test")).toThrow()
    } finally {
      if (originalEnv === undefined) delete process.env.DR_RESTORE_FORCE_UNSAFE_TARGET
      else process.env.DR_RESTORE_FORCE_UNSAFE_TARGET = originalEnv
    }
  })
})

describe("P4.2 §9: assertNotPooledConnection — backups must use a direct connection", () => {
  it("rejects a connection string with pgbouncer=true", () => {
    expect(() => assertNotPooledConnection("postgresql://u:p@host:6543/db?pgbouncer=true", "test")).toThrow(/pooled/)
  })

  it("rejects a connection string on port 6543 even without the pgbouncer flag", () => {
    expect(() => assertNotPooledConnection("postgresql://u:p@host:6543/db", "test")).toThrow(/pooled/)
  })

  it("accepts a plain direct connection string", () => {
    expect(() => assertNotPooledConnection("postgresql://postgres:x@localhost:5433/his_dev", "test")).not.toThrow()
  })
})

describe("P4.2: assertNotRemoteHost still guards backup/restore the same way it guards test setup", () => {
  it("rejects a Supabase-looking host", () => {
    expect(() => assertNotRemoteHost("postgresql://u:p@db.abcxyz.supabase.co:5432/postgres", "test")).toThrow(/hosted\/shared database/)
  })

  it("accepts localhost", () => {
    expect(() => assertNotRemoteHost("postgresql://postgres:x@localhost:5433/his_dev", "test")).not.toThrow()
  })
})

describe("P4.2 §10: backup filename generation", () => {
  it("produces a filesystem-safe timestamp with no colons or periods", () => {
    const ts = timestampForFilename(new Date("2026-09-01T19:29:02.629Z"))
    expect(ts).not.toMatch(/[:.]/)
    expect(ts).toBe("2026-09-01T19-29-02-629Z")
  })
})

describe("P4.2: environment guard (requireEnv)", () => {
  it("throws a clear error naming the missing variable", () => {
    const key = "P4_2_TEST_DOES_NOT_EXIST"
    delete process.env[key]
    expect(() => requireEnv(key)).toThrow(new RegExp(key))
  })

  it("returns the value when set", () => {
    process.env.P4_2_TEST_PRESENT = "value"
    expect(requireEnv("P4_2_TEST_PRESENT")).toBe("value")
    delete process.env.P4_2_TEST_PRESENT
  })
})

describe("P4.2 §9: backup configuration validation — runBackup refuses unsafe sources before touching pg_dump", () => {
  it("refuses a remote-host source without ever spawning pg_dump", async () => {
    await expect(
      runBackup({ label: "test", directUrl: "postgresql://u:p@db.abcxyz.supabase.co:5432/postgres" })
    ).rejects.toThrow(/hosted\/shared database/)
  })

  it("refuses a pooled-connection source without ever spawning pg_dump", async () => {
    await expect(
      runBackup({ label: "test", directUrl: "postgresql://u:p@localhost:6543/his_dev?pgbouncer=true" })
    ).rejects.toThrow(/pooled/)
  })
})
