// P4.2 §9: a safe logical (pg_dump) backup mechanism.
//
// npm run db:backup
//
// Reads BACKUP_SOURCE_DIRECT_URL (falling back to DIRECT_DATABASE_URL) and
// writes a timestamped, custom-format (`.dump`) pg_dump archive plus a
// metadata JSON sidecar into BACKUP_DIR (default "./backups"). Custom
// format is used specifically because it supports selective/flexible
// `pg_restore` (§9) rather than a plain-SQL dump.
//
// Execution environment: this repo's real target is `pg_dump`/`pg_restore`
// installed directly on whatever host runs the backup (a CI runner, an ops
// workstation, a small scheduled job) — the default here shells out to a
// bare `pg_dump` on PATH. In *this* local development environment (and any
// other where the Postgres client tools aren't installed on the host, only
// inside the docker-compose Postgres container), set DOCKER_EXEC_CONTAINER
// to the container name (`avant_his_postgres` locally) and the script runs
// the exact same `pg_dump` binary via `docker exec` instead — same tool,
// same output format, just a different process boundary. Never a mock.
import "dotenv/config"
import { createWriteStream, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { Client } from "pg"
import { parseDatabaseUrl, assertNotRemoteHost, assertNotPooledConnection } from "./lib"

export type BackupOptions = {
  /** Identifies the backup in its filename/metadata — never a credential, just a label like "his_dr_drill". */
  label: string
  /** Owner/direct connection string (never the transaction pooler — see assertNotPooledConnection). */
  directUrl: string
  backupDir?: string
  /** When set, pg_dump runs via `docker exec <container> pg_dump ...` instead of a bare host binary. */
  dockerExecContainer?: string
  /** Override the pg_dump binary name/path (default "pg_dump" on PATH, or inside the container above). */
  pgDumpBin?: string
}

export type BackupResult = {
  filePath: string
  metadataPath: string
  sizeBytes: number
  startedAt: string
  finishedAt: string
  postgresVersion: string
  migrationCount: number
  databaseLabel: string
}

export function timestampForFilename(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-")
}

/** Runs pg_dump, streaming its stdout directly to the destination file — works identically whether
 * invoked directly or wrapped in `docker exec -i`, and never places a password on the command line
 * (PGPASSWORD is passed via the child's environment only, never logged, never in argv). */
function runPgDump(opts: { host: string; port: string; user: string; password: string; dbName: string; destFile: string; dockerExecContainer?: string; pgDumpBin?: string }): Promise<void> {
  const bin = opts.pgDumpBin ?? "pg_dump"
  // `docker exec` runs pg_dump INSIDE the container's own network namespace,
  // where Postgres listens on its default internal port (5432) at
  // "localhost" — not the host-side port mapping (5433 locally, see
  // docker-compose.yml) the caller's connection string used to reach it
  // from outside. Only the process boundary changes here, never the
  // database being backed up (it's the exact same Postgres server either way).
  const host = opts.dockerExecContainer ? "localhost" : opts.host
  const port = opts.dockerExecContainer ? "5432" : opts.port
  const pgDumpArgs = ["-h", host, "-p", port, "-U", opts.user, "-d", opts.dbName, "-Fc", "--no-owner", "--no-acl"]

  const command = opts.dockerExecContainer ? "docker" : bin
  const args = opts.dockerExecContainer ? ["exec", "-i", "-e", `PGPASSWORD=${opts.password}`, opts.dockerExecContainer, bin, ...pgDumpArgs] : pgDumpArgs

  return new Promise((resolve, reject) => {
    const out = createWriteStream(opts.destFile)
    const child = spawn(command, args, {
      // Only set PGPASSWORD in the direct (non-docker-exec) case — the
      // docker-exec case passes it via `-e` above instead, since `docker
      // exec`'s own environment is what the *container's* pg_dump process
      // reads, not this Node process's env.
      env: opts.dockerExecContainer ? process.env : { ...process.env, PGPASSWORD: opts.password },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stderr = ""
    child.stderr.on("data", (chunk) => { stderr += chunk.toString() })
    child.stdout.pipe(out)
    child.on("error", (err) => reject(err))
    child.on("exit", (code) => {
      out.close()
      if (code === 0) resolve()
      else reject(new Error(`pg_dump exited with code ${code}: ${stderr.trim() || "(no stderr output)"}`))
    })
  })
}

/**
 * P4.4 §25/§27: writes to the same `operational_job_state` heartbeat table
 * the outbox sweep uses (src/lib/platform/operational-state.ts) — a plain
 * upsert via raw SQL rather than importing the Next.js app's Prisma client
 * into a standalone script (this script already opens its own `pg`
 * connections; reusing that pattern avoids the dynamic-import-after-env-
 * mutation dance the app's `db` singleton would otherwise need here). Best-
 * effort: if this write itself fails (e.g. the backup succeeded but the
 * heartbeat table isn't reachable for some unrelated reason), it must never
 * turn a real backup success into a reported failure, or vice versa — see
 * both call sites below.
 */
async function writeBackupHeartbeat(directUrl: string, outcome: { success: true; metadata: Record<string, unknown> } | { success: false; error: string }): Promise<void> {
  const client = new Client({ connectionString: directUrl })
  try {
    await client.connect()
    const now = new Date().toISOString()
    if (outcome.success) {
      await client.query(
        `INSERT INTO "operational_job_state" ("id", "key", "last_attempt_at", "last_success_at", "last_error", "metadata", "updated_at")
         VALUES (gen_random_uuid()::text, 'backup', $1, $1, NULL, $2::jsonb, $1)
         ON CONFLICT ("key") DO UPDATE SET "last_attempt_at" = $1, "last_success_at" = $1, "last_error" = NULL, "metadata" = $2::jsonb, "updated_at" = $1`,
        [now, JSON.stringify(outcome.metadata)]
      )
    } else {
      const truncatedError = outcome.error.slice(0, 500)
      await client.query(
        `INSERT INTO "operational_job_state" ("id", "key", "last_attempt_at", "last_failure_at", "last_error", "updated_at")
         VALUES (gen_random_uuid()::text, 'backup', $1, $1, $2, $1)
         ON CONFLICT ("key") DO UPDATE SET "last_attempt_at" = $1, "last_failure_at" = $1, "last_error" = $2, "updated_at" = $1`,
        [now, truncatedError]
      )
    }
  } catch (heartbeatErr) {
    console.error(`[backup] Warning: failed to record the operational heartbeat (backup itself is unaffected): ${heartbeatErr instanceof Error ? heartbeatErr.message : String(heartbeatErr)}`)
  } finally {
    await client.end().catch(() => {})
  }
}

export async function runBackup(options: BackupOptions): Promise<BackupResult> {
  assertNotRemoteHost(options.directUrl, "Backup source connection")
  assertNotPooledConnection(options.directUrl, "Backup source connection")

  const parsed = parseDatabaseUrl(options.directUrl)
  const dbName = parsed.pathname.replace(/^\//, "")
  const host = parsed.hostname
  const port = parsed.port || "5432"
  const user = decodeURIComponent(parsed.username)
  const password = decodeURIComponent(parsed.password)

  const backupDir = path.resolve(options.backupDir ?? process.env.BACKUP_DIR ?? "./backups")
  mkdirSync(backupDir, { recursive: true })

  const startedAt = new Date()
  const filename = `${options.label}_${timestampForFilename(startedAt)}.dump`
  const filePath = path.join(backupDir, filename)

  console.log(`[backup] Starting pg_dump of "${dbName}" (label: ${options.label}) -> ${filePath}`)
  try {
    await runPgDump({
      host, port, user, password, dbName, destFile: filePath,
      dockerExecContainer: options.dockerExecContainer,
      pgDumpBin: options.pgDumpBin,
    })
  } catch (err) {
    // Never leave a partial/corrupt dump file lying around looking like a
    // valid backup — a half-written .dump is worse than none at all.
    try { unlinkSync(filePath) } catch { /* best-effort cleanup */ }
    // P4.4 §27: a failed backup must create a safe operational error signal
    // — never silently exit non-zero with nothing durable to show for it.
    const message = err instanceof Error ? err.message : String(err)
    await writeBackupHeartbeat(options.directUrl, { success: false, error: message })
    throw err
  }

  const finishedAt = new Date()
  const sizeBytes = statSync(filePath).size

  // Metadata queries run through a plain `pg` connection (never through
  // docker exec — this Node process can always reach the same host/port
  // pg_dump itself connected to, directly) so the JSON sidecar records
  // useful, secret-free facts about the backup.
  const client = new Client({ connectionString: options.directUrl })
  await client.connect()
  let postgresVersion = "unknown"
  let migrationCount = 0
  try {
    const versionResult = await client.query("SELECT version()")
    postgresVersion = String(versionResult.rows[0]?.version ?? "unknown")
    const migrationsResult = await client.query('SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')
    migrationCount = migrationsResult.rows[0]?.count ?? 0
  } catch {
    // Metadata is best-effort — a backup that succeeded but couldn't read
    // its own metadata is still a completed backup, not a failed one.
  } finally {
    await client.end()
  }

  const metadata = {
    label: options.label,
    databaseName: dbName,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    postgresVersion,
    migrationCount,
    filename,
    sizeBytes,
    status: "completed",
  }
  const metadataPath = `${filePath}.meta.json`
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2))

  // P4.4 §25: the durable success heartbeat — only filename/size/version/
  // migration-count, matching exactly what the .meta.json sidecar already
  // records (never a full path, never a credential).
  await writeBackupHeartbeat(options.directUrl, { success: true, metadata: { filename, sizeBytes, postgresVersion, migrationCount, label: options.label } })

  console.log(`[backup] Completed: ${filename} (${sizeBytes} bytes, ${migrationCount} migrations, Postgres: ${postgresVersion.split(",")[0]})`)

  return { filePath, metadataPath, sizeBytes, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), postgresVersion, migrationCount, databaseLabel: options.label }
}

async function main() {
  const directUrl = process.env.BACKUP_SOURCE_DIRECT_URL ?? process.env.DIRECT_DATABASE_URL
  if (!directUrl) {
    throw new Error("BACKUP_SOURCE_DIRECT_URL (or DIRECT_DATABASE_URL) is not set — nothing to back up.")
  }
  const label = process.env.BACKUP_SOURCE_LABEL ?? parseDatabaseUrl(directUrl).pathname.replace(/^\//, "")
  await runBackup({
    label,
    directUrl,
    backupDir: process.env.BACKUP_DIR,
    dockerExecContainer: process.env.DOCKER_EXEC_CONTAINER,
    pgDumpBin: process.env.PG_DUMP_BIN,
  })
}

// Only run when invoked directly (`tsx scripts/db/backup.ts`), not when dr-drill.ts imports runBackup().
if (process.argv[1] && process.argv[1].endsWith("backup.ts")) {
  main().catch((err) => {
    console.error(`\ndb:backup failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
