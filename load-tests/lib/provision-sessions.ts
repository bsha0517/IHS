// npx tsx load-tests/lib/provision-sessions.ts
//
// P4.5 §10: pre-provisions real, valid Session rows for a batch of the
// synthetic load-test staff users generate-load-data.ts already created —
// the same Session model, the same token-hashing (`hashToken`), the same
// 12-hour expiry every real login produces, just created directly rather
// than by paying Argon2's real hashing cost 250 times in a row before a
// load run can even start. This is a standard, legitimate load-testing
// technique for isolating "how fast is this page" from "how fast is
// login" — a small, separate scenario in load-tests/http/login.ts
// exercises the real login path's own latency instead.
//
// Writes raw session tokens (each usable as a real session cookie) to
// load-tests/results/sessions.json — gitignored, never committed, and
// meaningless outside this exact his_load_test database (a leaked token
// only ever grants access to synthetic data with no real PHI).

import "dotenv/config"
import { randomBytes, createHash } from "node:crypto"
import { writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { assertIsLoadTestDatabase, assertNotRemoteHost, requireEnv } from "../../scripts/db/lib"

const DIRECT_URL = requireEnv("LOAD_TEST_DIRECT_DATABASE_URL")
const RUNTIME_URL = requireEnv("LOAD_TEST_DATABASE_URL")
assertNotRemoteHost(RUNTIME_URL, "LOAD_TEST_DATABASE_URL")
assertIsLoadTestDatabase(RUNTIME_URL, "LOAD_TEST_DATABASE_URL")
assertIsLoadTestDatabase(DIRECT_URL, "LOAD_TEST_DIRECT_DATABASE_URL")

process.env.DATABASE_URL = RUNTIME_URL

function generateRawToken(): string {
  return randomBytes(32).toString("base64url")
}
function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex")
}

async function main() {
  const { db } = await import("../../src/lib/db")

  const users = await db.user.findMany({
    where: { email: { startsWith: "loadtest-staff-" } },
    include: { roles: { include: { role: true } }, branchAccess: true },
  })
  if (users.length === 0) {
    throw new Error("No loadtest-staff-* users found — run generate-load-data.ts first.")
  }

  const sessionsByRole: Record<string, { token: string; userId: string; email: string; branchId: string | null }[]> = {}
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000)

  for (const user of users) {
    const rawToken = generateRawToken()
    await db.session.create({
      data: { userId: user.id, tokenHash: hashToken(rawToken), expiresAt, activeBranchId: user.branchAccess[0]?.branchId ?? null },
    })
    const roleName = user.roles[0]?.role.name ?? "Unknown"
    sessionsByRole[roleName] ??= []
    sessionsByRole[roleName].push({ token: rawToken, userId: user.id, email: user.email, branchId: user.branchAccess[0]?.branchId ?? null })
  }

  const outDir = path.resolve(import.meta.dirname, "../results")
  mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, "sessions.json")
  writeFileSync(outPath, JSON.stringify(sessionsByRole, null, 2))

  console.log(`Provisioned ${users.length} sessions across ${Object.keys(sessionsByRole).length} roles -> ${outPath}`)
  await db.$disconnect()
}

main().catch((err) => {
  console.error(`provision-sessions failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
