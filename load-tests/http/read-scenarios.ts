// npx tsx load-tests/http/read-scenarios.ts [scenario] [concurrency]
//
// P4.5 §16-27: HTTP-level read-path load — real Next.js page routes,
// real session cookies (pre-provisioned by provision-sessions.ts), real
// his_load_test data at scale. Run against a `next start` production
// build pointed at his_load_test (see load-tests/README.md for the exact
// command).
//
// Requires: LOAD_TEST_BASE_URL (default http://localhost:3105) and
// load-tests/results/sessions.json (run provision-sessions.ts first).
//
// Design note: each scenario picks ONE representative session (and its
// branch) up front, fetches sample record IDs SCOPED TO THAT SAME BRANCH
// (branch isolation is real and enforced server-side — a Receptionist's
// session can only ever read the branch(es) their own UserBranchAccess
// grants, exactly as production requires), then drives the full concurrent
// request wave through that one session. This measures real per-request
// server-side work (DB queries, rendering) under real concurrency — which
// is what this phase needs — without conflating it with a second, separate
// concern (whether N distinct logged-in users behave differently from one
// reused session, which they don't: the server does the same work per
// request either way).

import "dotenv/config"
import { readFileSync } from "node:fs"
import path from "node:path"
import { requireEnv, assertIsLoadTestDatabase, assertNotRemoteHost } from "../../scripts/db/lib"
import { runLoad, computeStats, printStatsTable, type Stats } from "../lib/http-client"

const BASE_URL = process.env.LOAD_TEST_BASE_URL ?? "http://localhost:3105"

type SessionEntry = { token: string; userId: string; email: string; branchId: string | null }

function loadSessions(): Record<string, SessionEntry[]> {
  const p = path.resolve(import.meta.dirname, "../results/sessions.json")
  return JSON.parse(readFileSync(p, "utf8"))
}

function pickSession(sessions: Record<string, SessionEntry[]>, role: string): SessionEntry {
  const entries = sessions[role]
  if (!entries || entries.length === 0) throw new Error(`No provisioned session for role "${role}" — run provision-sessions.ts first.`)
  return entries[Math.floor(Math.random() * entries.length)]
}

async function fetchSampleIds(branchId: string | null) {
  const directUrl = requireEnv("LOAD_TEST_DIRECT_DATABASE_URL")
  assertNotRemoteHost(directUrl, "LOAD_TEST_DIRECT_DATABASE_URL")
  assertIsLoadTestDatabase(directUrl, "LOAD_TEST_DIRECT_DATABASE_URL")
  process.env.DATABASE_URL = directUrl
  const { db } = await import("../../src/lib/db")

  const branchFilter = branchId ? { branchId } : {}
  const [patients, encounters, invoices] = await Promise.all([
    db.patient.findMany({ where: branchId ? { registrationBranchId: branchId } : {}, take: 30, select: { id: true } }),
    db.encounter.findMany({ where: branchFilter, take: 30, select: { id: true } }),
    db.invoice.findMany({ where: branchFilter, take: 30, select: { id: true } }),
  ])
  await db.$disconnect()
  return {
    patientIds: patients.map((p) => p.id),
    encounterIds: encounters.map((e) => e.id),
    invoiceIds: invoices.map((i) => i.id),
  }
}

type Scenario = { role: string; buildUrls: (ids: Awaited<ReturnType<typeof fetchSampleIds>>) => string[] }

const SCENARIOS: Record<string, Scenario> = {
  reception: {
    role: "Receptionist",
    buildUrls: (ids) => ["/patients", "/patients?search=Ahmed", "/appointments", "/queue", "/reception", ...ids.patientIds.slice(0, 10).map((id) => `/patients/${id}`)],
  },
  nursing: { role: "Nurse", buildUrls: (ids) => ["/queue", ...ids.encounterIds.slice(0, 15).map((id) => `/encounters/${id}`)] },
  doctor: {
    role: "Doctor",
    buildUrls: (ids) => ["/queue", "/dashboard", ...ids.patientIds.slice(0, 15).map((id) => `/patients/${id}`), ...ids.encounterIds.slice(0, 15).map((id) => `/encounters/${id}`)],
  },
  // "?status=pending" deliberately NOT used — a real bug found while
  // building this scenario: /laboratory and /radiology pass an unvalidated
  // `status` query param straight into a Prisma `ClinicalOrderStatus`
  // filter, which 500s for any value outside that enum (e.g. "pending" —
  // the intuitive-looking value this scenario originally tried — isn't
  // actually a member; the real values are draft/ordered/acknowledged/
  // in_progress/completed/cancelled). Flagged as a background task
  // (out-of-scope input-validation bug, not a performance finding) rather
  // than fixed here — see this phase's own report for the reference.
  lab: { role: "Laboratory Technician", buildUrls: () => ["/laboratory", "/laboratory?status=ordered"] },
  radiology: { role: "Radiology Technician", buildUrls: () => ["/radiology", "/radiology?status=ordered"] },
  pharmacy: { role: "Pharmacist", buildUrls: () => ["/pharmacy", "/pharmacy?status=pending"] },
  pos: { role: "Cashier", buildUrls: (ids) => ["/pos", "/invoices", "/payments", ...ids.invoiceIds.slice(0, 10).map((id) => `/invoices/${id}`)] },
  inventory: { role: "Inventory Manager", buildUrls: () => ["/inventory", "/purchasing", "/suppliers"] },
  // "/reports" deliberately excluded — it requires `branch.view`, which the
  // seeded Accountant role doesn't hold (a real, correct authorization
  // boundary, confirmed while building this scenario — not a load-test bug).
  accounting: { role: "Accountant", buildUrls: () => ["/accounting", "/receivables", "/payables"] },
  hr: { role: "HR Manager", buildUrls: () => ["/employees", "/attendance", "/leave", "/payroll"] },
  dashboard: { role: "Organization Administrator", buildUrls: () => ["/dashboard", "/admin/operations"] },
}

async function main() {
  const sessions = loadSessions()

  const scenarioArg = process.argv[2]
  const concurrencyArg = process.argv[3] ? Number(process.argv[3]) : undefined
  const concurrencyLevels = concurrencyArg ? [concurrencyArg] : [25, 50]
  const requestedScenarios = scenarioArg && scenarioArg !== "all" ? [scenarioArg] : Object.keys(SCENARIOS)

  const rows: { scenario: string; concurrency: number; stats: Stats }[] = []
  for (const name of requestedScenarios) {
    const scenario = SCENARIOS[name]
    if (!scenario) throw new Error(`Unknown scenario "${name}". Known: ${Object.keys(SCENARIOS).join(", ")}`)
    const session = pickSession(sessions, scenario.role)
    const cookie = `his_session=${session.token}`
    const ids = await fetchSampleIds(session.branchId)
    const urls = scenario.buildUrls(ids).map((u) => `${BASE_URL}${u}`)

    for (const concurrency of concurrencyLevels) {
      const totalRequests = Number(process.env.LOAD_TEST_MULTIPLIER ?? 4) * concurrency
      const { results, wallClockMs } = await runLoad({ urls, cookie, concurrency, totalRequests })
      const stats = computeStats(results, wallClockMs)
      rows.push({ scenario: name, concurrency, stats })
      const sampleErrors = results.filter((r) => !r.ok).slice(0, 3)
      if (sampleErrors.length > 0) {
        console.log(`  [${name}@${concurrency}] sample errors: ${sampleErrors.map((e) => `${e.status}${e.error ? ` (${e.error})` : ""}`).join(", ")}`)
      }
    }
  }

  printStatsTable(rows)
}

main().catch((err) => {
  console.error(`read-scenarios failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
  process.exit(1)
})
