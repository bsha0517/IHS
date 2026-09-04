// P4.2 §13/§14: the restore mechanism, with a fail-closed safety guard.
//
// npm run db:restore
//
// Restores a pg_dump custom-format archive into a FRESH, dropped-and-
// recreated database whose name must match the `his_restore_test` naming
// pattern (assertIsSafeRestoreTarget, scripts/db/lib.ts) — there is no
// override. See docs/BACKUP_DISASTER_RECOVERY.md's "Restore Safety" section
// for why this has no escape hatch and what a real incident restore (into
// something other than an isolated test database) actually looks like
// instead — a deliberate, out-of-band procedure, not this script.
import "dotenv/config"
import { createReadStream } from "node:fs"
import { spawn } from "node:child_process"
import { Client } from "pg"
import { parseDatabaseUrl, assertNotRemoteHost, assertNotPooledConnection, assertIsSafeRestoreTarget, requireEnv, runSql } from "./lib"
import { readFileSync } from "node:fs"
import path from "node:path"

const GRANT_SQL_PATH = path.resolve(import.meta.dirname, "../../prisma/db-setup/local-grant-runtime-role.sql")

export type RestoreOptions = {
  backupFilePath: string
  /** Owner/direct connection string for the restore TARGET database — its name must pass assertIsSafeRestoreTarget. */
  targetDirectUrl: string
  dockerExecContainer?: string
  pgRestoreBin?: string
}

export type RestoreResult = {
  targetDatabase: string
  restoredAt: string
}

function runPgRestore(opts: { host: string; port: string; user: string; password: string; dbName: string; sourceFile: string; dockerExecContainer?: string; pgRestoreBin?: string }): Promise<void> {
  const bin = opts.pgRestoreBin ?? "pg_restore"
  // See backup.ts's runPgDump for why host/port are overridden when running
  // via `docker exec` — same container, same internal-port reasoning.
  const host = opts.dockerExecContainer ? "localhost" : opts.host
  const port = opts.dockerExecContainer ? "5432" : opts.port
  const pgRestoreArgs = ["-h", host, "-p", port, "-U", opts.user, "-d", opts.dbName, "--no-owner", "--no-acl"]

  const command = opts.dockerExecContainer ? "docker" : bin
  const args = opts.dockerExecContainer ? ["exec", "-i", "-e", `PGPASSWORD=${opts.password}`, opts.dockerExecContainer, bin, ...pgRestoreArgs] : pgRestoreArgs

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: opts.dockerExecContainer ? process.env : { ...process.env, PGPASSWORD: opts.password },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stderr = ""
    child.stderr.on("data", (chunk) => { stderr += chunk.toString() })
    child.stdout.on("data", () => {})
    createReadStream(opts.sourceFile).pipe(child.stdin)
    child.on("error", (err) => reject(err))
    child.on("exit", (code) => {
      // pg_restore exits 1 for warnings (e.g. "already exists" notices on a
      // truly clean target are not expected here since we always restore
      // into a freshly created empty database — see runRestore below — but
      // real warnings unrelated to data loss are common enough that a
      // nonzero exit alone isn't treated as fatal; the caller's own
      // verification step (counts/reconciliation) is the real proof a
      // restore succeeded, not pg_restore's exit code in isolation).
      if (code === 0 || code === 1) {
        if (code === 1) console.warn(`[restore] pg_restore exited 1 (warnings) — proceeding to verification:\n${stderr.trim()}`)
        resolve()
      } else {
        reject(new Error(`pg_restore exited with code ${code}: ${stderr.trim() || "(no stderr output)"}`))
      }
    })
  })
}

export async function runRestore(options: RestoreOptions): Promise<RestoreResult> {
  assertNotRemoteHost(options.targetDirectUrl, "Restore target connection")
  assertNotPooledConnection(options.targetDirectUrl, "Restore target connection")
  const targetDbName = assertIsSafeRestoreTarget(options.targetDirectUrl, "Restore target connection")

  const parsed = parseDatabaseUrl(options.targetDirectUrl)
  const host = parsed.hostname
  const port = parsed.port || "5432"
  const user = decodeURIComponent(parsed.username)
  const password = decodeURIComponent(parsed.password)

  // Connect to the cluster's maintenance database (not the target itself —
  // you cannot DROP a database while connected to it) to drop-if-exists and
  // recreate the target clean. This is the one place a restore is allowed
  // to be destructive — precisely because assertIsSafeRestoreTarget above
  // already proved the name can only be an isolated restore-test database.
  const maintenanceUrl = new URL(options.targetDirectUrl)
  maintenanceUrl.pathname = "/postgres"
  const maintenance = new Client({ connectionString: maintenanceUrl.toString() })
  await maintenance.connect()
  try {
    console.log(`[restore] Dropping (if exists) and recreating "${targetDbName}"...`)
    await maintenance.query(`DROP DATABASE IF EXISTS "${targetDbName}" WITH (FORCE)`)
    await maintenance.query(`CREATE DATABASE "${targetDbName}"`)
  } finally {
    await maintenance.end()
  }

  console.log(`[restore] Running pg_restore into "${targetDbName}" from ${options.backupFilePath}...`)
  await runPgRestore({
    host, port, user, password, dbName: targetDbName, sourceFile: options.backupFilePath,
    dockerExecContainer: options.dockerExecContainer,
    pgRestoreBin: options.pgRestoreBin,
  })

  // §27/§28: pg_dump ran with --no-owner --no-acl (portable across
  // environments whose role names may differ), so the restored database has
  // NO table-level grants for the restricted runtime role at all yet —
  // reusing the exact same grant script local dev/test setup already uses,
  // not a second copy of the same GRANT/REVOKE logic (§27's own instruction).
  console.log(`[restore] Reapplying the restricted runtime role's grants (local-grant-runtime-role.sql)...`)
  const grantSql = readFileSync(GRANT_SQL_PATH, "utf8")
  await runSql(options.targetDirectUrl, grantSql)

  console.log(`[restore] Done. Target database: "${targetDbName}".`)
  return { targetDatabase: targetDbName, restoredAt: new Date().toISOString() }
}

async function main() {
  const backupFilePath = requireEnv("RESTORE_BACKUP_FILE")
  const targetDirectUrl = requireEnv("RESTORE_TARGET_DIRECT_URL")
  await runRestore({
    backupFilePath,
    targetDirectUrl,
    dockerExecContainer: process.env.DOCKER_EXEC_CONTAINER,
    pgRestoreBin: process.env.PG_RESTORE_BIN,
  })
}

if (process.argv[1] && process.argv[1].endsWith("restore.ts")) {
  main().catch((err) => {
    console.error(`\ndb:restore failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
