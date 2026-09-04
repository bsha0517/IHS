// P4.8 §11/§12 — the single pre-release verification command.
//
// npm run release:check
//
// Runs the required release gates in order and stops at the first failure —
// there is no "warning but deploy anyway" mode for a required gate (§12): a
// required gate failing means DO NOT RELEASE, so this exits nonzero and a
// human reads exactly which step failed and why, from that step's own
// already-existing output (this script doesn't re-implement or duplicate
// any check's own logic — it only sequences the same commands a developer
// would otherwise run by hand: `npx prisma validate`, `npx prisma migrate
// status`, `npm run db:security:check`, `npm run typecheck`, `npm run lint`,
// `npm run test:components`, `npm run test`, `npm run build`).
//
// P4.9.1 §11: `db:security:check` runs right after the migration-drift
// check — both are read-only checks of the same target database's current
// state before anything deploys against it. It is deliberately a *check*
// here, not an *apply* — this gate must never write to the database it's
// verifying; if it fails, the fix is to run `npm run db:security:apply`
// (see DATABASE.md's "Row Level Security" section) and re-run this gate,
// not to have this gate silently apply it.
//
// E2E (`npm run test:e2e`) is deliberately NOT included here — it needs a
// running `next dev`/`next start` server (playwright.config.ts's own
// `webServer`), which this script doesn't manage; §13/§62 treat release
// smoke as its own separate step, run against a release candidate or a
// staging deployment, not bundled into this fast, server-less gate.
//
// This script itself makes no database changes and takes no backup — it is
// a READ-ONLY verification gate. Backup-before-migration (§26) and the
// actual `prisma migrate deploy` are separate, deliberate steps in
// docs/RELEASE_RUNBOOK.md, run by a human after this gate is green.
//
// Deliberately does NOT `import "dotenv/config"` itself, unlike most other
// scripts/*.ts entry points in this repo — every gate below is spawned as
// its own child process (via `runStep`, inheriting this process's
// `process.env` unmodified) and already loads its own env correctly on its
// own (`prisma.config.ts`, vitest's own `dotenv/config` setup file, and
// Next's native `.env` loading for the build). Loading dotenv here too
// would set `NODE_ENV` from `.env` (`"development"` in this project's own
// `.env`) in THIS process before spawning children — dotenv does not
// override an already-set variable, but it very much sets an *unset* one,
// and that value then propagates to every child via `runStep`'s inherited
// `process.env`, silently overriding Vitest's own "default to
// `NODE_ENV=test`" behavior for the integration-test gate (a real bug this
// caught during this phase's own release-simulation run — see
// P4_8_RELEASE_MIGRATION_UPGRADE_SAFETY_REPORT.md).
import { runStep } from "../db/lib"

export type Gate = { name: string; command: string; args: string[] }

export const GATES: Gate[] = [
  { name: "Prisma schema validation", command: "npx", args: ["prisma", "validate"] },
  { name: "Migration status (drift check)", command: "npx", args: ["prisma", "migrate", "status"] },
  { name: "DB security check (RLS)", command: "npm", args: ["run", "db:security:check"] },
  { name: "TypeScript", command: "npm", args: ["run", "typecheck"] },
  { name: "Lint", command: "npm", args: ["run", "lint"] },
  { name: "Component tests", command: "npm", args: ["run", "test:components"] },
  { name: "Integration tests", command: "npm", args: ["run", "test"] },
  { name: "Production build", command: "npm", args: ["run", "build"] },
]

async function main() {
  console.log("=".repeat(70))
  console.log("P4.8 Release Gate — npm run release:check")
  console.log("=".repeat(70))
  console.log(`Gates to run: ${GATES.map((g) => g.name).join(" -> ")}\n`)

  const results: { name: string; ok: boolean; durationMs: number }[] = []

  for (const gate of GATES) {
    const startedAt = Date.now()
    console.log(`\n--- ${gate.name} ${"-".repeat(Math.max(0, 60 - gate.name.length))}`)
    try {
      await runStep(gate.command, gate.args, process.env)
      const durationMs = Date.now() - startedAt
      results.push({ name: gate.name, ok: true, durationMs })
      console.log(`--- ${gate.name}: PASS (${(durationMs / 1000).toFixed(1)}s)`)
    } catch (err) {
      const durationMs = Date.now() - startedAt
      results.push({ name: gate.name, ok: false, durationMs })
      console.log(`--- ${gate.name}: FAIL (${(durationMs / 1000).toFixed(1)}s)`)
      console.error(`\n${err instanceof Error ? err.message : String(err)}`)
      printSummary(results, GATES)
      console.error("\nRELEASE GATE FAILED — DO NOT RELEASE. Fix the failing gate above and re-run npm run release:check.")
      process.exit(1)
    }
  }

  printSummary(results, GATES)
  console.log("\nALL RELEASE GATES PASSED.")
  console.log("Next: see docs/RELEASE_CHECKLIST.md for backup/migration/deploy/smoke steps.")
}

function printSummary(results: { name: string; ok: boolean; durationMs: number }[], allGates: Gate[]) {
  console.log("\n" + "=".repeat(70))
  console.log("Release gate summary")
  console.log("=".repeat(70))
  for (const gate of allGates) {
    const result = results.find((r) => r.name === gate.name)
    if (!result) {
      console.log(`  [SKIPPED] ${gate.name}`)
    } else {
      console.log(`  [${result.ok ? " PASS " : " FAIL "}] ${gate.name} (${(result.durationMs / 1000).toFixed(1)}s)`)
    }
  }
}

// Only run when invoked directly (`tsx scripts/release/check.ts`), not when
// a test imports GATES to verify its shape.
if (process.argv[1] && process.argv[1].endsWith("check.ts")) {
  main().catch((err) => {
    console.error(`\nrelease:check failed unexpectedly: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
    process.exit(1)
  })
}
