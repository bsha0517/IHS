// npx tsx load-tests/concurrency/write-scenarios.ts [scenario]
//
// P4.5 §36-39: write-path concurrency correctness AND latency — using the
// REAL domain functions (generateSystemCharge, generateInvoice,
// recordPayment, recordAdjustment, refunds), invoked concurrently against
// `his_load_test`, exactly like this project's own existing
// `test/integration/*-concurrency.test.ts` files already do for their own
// narrower cases (see e.g. outbox-concurrency.test.ts, already covering
// §74's "two near-concurrent sweeps" requirement — not duplicated here).
//
// HONEST SCOPE NOTE (also in the P4.5 report): this is why these scenarios
// run as direct Node-level domain-function calls rather than through k6/
// HTTP — Next.js Server Actions are POSTs carrying a build-specific,
// hashed action reference, not a stable REST-style endpoint a load tool
// can target without reverse-engineering that encoding per build. Calling
// the same domain functions the Server Actions themselves call exercises
// the exact same transactions/locks/constraints against the exact same
// database — the correctness-critical layer — directly and reliably.

import "dotenv/config"
import { randomUUID } from "node:crypto"
import { requireEnv, assertIsLoadTestDatabase, assertNotRemoteHost } from "../../scripts/db/lib"

const DIRECT_URL = requireEnv("LOAD_TEST_DIRECT_DATABASE_URL")
const RUNTIME_URL = requireEnv("LOAD_TEST_DATABASE_URL")
assertNotRemoteHost(DIRECT_URL, "LOAD_TEST_DIRECT_DATABASE_URL")
assertNotRemoteHost(RUNTIME_URL, "LOAD_TEST_DATABASE_URL")
assertIsLoadTestDatabase(DIRECT_URL, "LOAD_TEST_DIRECT_DATABASE_URL")
assertIsLoadTestDatabase(RUNTIME_URL, "LOAD_TEST_DATABASE_URL")
process.env.DATABASE_URL = RUNTIME_URL

type Timed<T> = { result?: T; error?: string; durationMs: number }

async function timed<T>(fn: () => Promise<T>): Promise<Timed<T>> {
  const start = performance.now()
  try {
    const result = await fn()
    return { result, durationMs: performance.now() - start }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), durationMs: performance.now() - start }
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}
function reportLatency(label: string, durations: number[]) {
  const sorted = [...durations].sort((a, b) => a - b)
  console.log(`  ${label}: n=${sorted.length} p50=${percentile(sorted, 50).toFixed(0)}ms p95=${percentile(sorted, 95).toFixed(0)}ms max=${(sorted[sorted.length - 1] ?? 0).toFixed(0)}ms`)
}

async function main() {
  const { db } = await import("../../src/lib/db")
  const { generateSystemCharge } = await import("../../src/lib/domains/billing/charges")
  const { generateInvoice, getInvoice } = await import("../../src/lib/domains/billing/invoices")
  const { recordPayment } = await import("../../src/lib/domains/billing/payments")
  const { openSession: openCashierSession } = await import("../../src/lib/domains/billing/cashier")
  const { recordAdjustment, receiveStock } = await import("../../src/lib/domains/inventory/stock")
  const { requestRefund, authorizeRefund, completeRefund } = await import("../../src/lib/domains/billing/refunds")
  const { dispatchPendingOutboxEvents } = await import("../../src/lib/platform/outbox")
  type SessionContext = Awaited<ReturnType<typeof buildSession>>

  const organization = await db.organization.findFirstOrThrow()
  const branch = await db.branch.findFirstOrThrow({ where: { organizationId: organization.id } })
  const product = await db.product.findFirstOrThrow({ where: { organizationId: organization.id } })
  const staffUser = await db.user.findFirstOrThrow({ where: { organizationId: organization.id, email: { not: { contains: "loadtest" } } } })
  const patient = await db.patient.findFirstOrThrow({ where: { organizationId: organization.id, registrationBranchId: branch.id } })

  async function buildSession() {
    return {
      sessionId: `p4-5-concurrency-${randomUUID()}`,
      user: { id: staffUser.id, organizationId: organization.id, email: "p4-5@test.local", firstName: "P45", lastName: "Load" },
      activeBranchId: branch.id, branchIds: [branch.id],
      permissions: new Set(["patient.view", "charge.create", "invoice.create", "invoice.view", "payment.create", "cashier.open", "cashier.view", "inventory.adjust", "refund.request", "refund.authorize"]),
      roleNames: ["P4.5 Load Concurrency"],
    }
  }
  const session: SessionContext = await buildSession()

  async function scenarioStock(concurrency: number) {
    console.log(`\n--- Stock concurrency (§36): ${concurrency} concurrent 'out' adjustments racing a near-empty batch ---`)
    const batch = await db.$transaction((tx) =>
      receiveStock(tx, {
        organizationId: organization.id, branchId: branch.id, productId: product.id,
        batchNumber: `P45-STOCK-${randomUUID()}`, purchaseCost: 10, quantity: Math.max(1, concurrency - 5), // deliberately fewer units than requests (floored at 1 so concurrency<6 "control" runs don't receive a nonsensical negative batch)
        referenceType: "p4_5_load", referenceId: "stock-scenario", performedBy: staffUser.id,
      })
    )
    const attempts = await Promise.all(
      Array.from({ length: concurrency }, () =>
        timed(() => recordAdjustment(session, { branchId: branch.id, productId: product.id, batchId: batch.id, direction: "out", quantity: 1, transactionType: "adjustment", reason: "P4.5 load concurrency" }))
      )
    )
    const succeeded = attempts.filter((a) => !a.error).length
    const failed = attempts.filter((a) => a.error).length
    reportLatency("adjustment", attempts.map((a) => a.durationMs))

    const balanceRow = await db.stockLedgerEntry.aggregate({ where: { organizationId: organization.id, productId: product.id, batchId: batch.id }, _sum: { quantity: true } })
    const finalBalance = Number(balanceRow._sum.quantity ?? 0)
    const negative = finalBalance < 0
    console.log(`  succeeded=${succeeded} failed=${failed} finalBalance=${finalBalance} ${negative ? "❌ NEGATIVE STOCK — INVARIANT VIOLATED" : "✅ never negative"}`)
    if (negative) throw new Error("BLOCKER: stock went negative under concurrency")
    return { succeeded, failed, finalBalance, negative }
  }

  async function scenarioInvoice(concurrency: number) {
    console.log(`\n--- Invoice concurrency (§37): ${concurrency} concurrent generateInvoice calls racing the SAME Charges ---`)
    const charge = await db.$transaction((tx) =>
      generateSystemCharge(tx, { organizationId: organization.id, branchId: branch.id, patientId: patient.id, sourceType: "other", description: "P4.5 load concurrency charge", quantity: 1, unitPrice: 100 })
    )
    const attempts = await Promise.all(
      Array.from({ length: concurrency }, () => timed(() => generateInvoice(session, { patientId: patient.id, branchId: branch.id, chargeIds: [charge.id], discountAmount: 0 })))
    )
    const succeeded = attempts.filter((a) => !a.error)
    const failed = attempts.filter((a) => a.error).length
    reportLatency("generateInvoice", attempts.map((a) => a.durationMs))

    const invoiceLines = await db.invoiceLine.findMany({ where: { chargeId: charge.id } })
    const singleOwner = invoiceLines.length === 1 && succeeded.length === 1
    console.log(`  succeeded=${succeeded.length} failed=${failed} invoiceLinesForCharge=${invoiceLines.length} ${singleOwner ? "✅ exactly one valid ownership path" : "❌ INVARIANT VIOLATED — charge owned by >1 invoice or 0 succeeded"}`)
    if (!singleOwner) throw new Error("BLOCKER: charge did not resolve to exactly one invoice owner under concurrency")
    return { succeeded: succeeded.length, failed, invoiceLinesForCharge: invoiceLines.length }
  }

  async function scenarioPayment(concurrency: number) {
    console.log(`\n--- Payment concurrency (§38): ${concurrency} concurrent recordPayment calls racing the same outstanding balance ---`)
    // A dedicated cashier user, same reasoning as scenarioRefund below —
    // one open register per cashier is real, correct app behavior, and a
    // dedicated user makes this scenario (and a re-run of the whole
    // script) independent of whatever other scenarios already did.
    const paymentCashier = await db.user.create({ data: { organizationId: organization.id, email: `p4-5-payment-cashier-${randomUUID()}@load.test`, firstName: "P45", lastName: "PaymentCashier", passwordHash: "x" } })
    const paymentSession: SessionContext = { ...session, user: { ...session.user, id: paymentCashier.id } }

    const charge = await db.$transaction((tx) =>
      generateSystemCharge(tx, { organizationId: organization.id, branchId: branch.id, patientId: patient.id, sourceType: "other", description: "P4.5 payment concurrency", quantity: 1, unitPrice: 100 })
    )
    const invoice = await generateInvoice(paymentSession, { patientId: patient.id, branchId: branch.id, chargeIds: [charge.id], discountAmount: 0 })
    const register = await openCashierSession(paymentSession, { branchId: branch.id, openingCash: 0 })

    const attempts = await Promise.all(
      Array.from({ length: concurrency }, () =>
        timed(() => recordPayment(paymentSession, { invoiceId: invoice.id, cashierSessionId: register.id, tenders: [{ method: "cash", amount: 100 }] }))
      )
    )
    const succeeded = attempts.filter((a) => !a.error).length
    const failed = attempts.filter((a) => a.error).length
    reportLatency("recordPayment", attempts.map((a) => a.durationMs))

    const reloaded = await getInvoice(paymentSession, invoice.id)
    const allocSum = reloaded.paymentAllocations.reduce((s, a) => s + Number(a.amount), 0)
    const overpaid = Number(reloaded.paidAmount) > Number(reloaded.totalAmount) + 0.001
    const allocMismatch = Math.abs(allocSum - Number(reloaded.paidAmount)) > 0.001
    console.log(`  succeeded=${succeeded} failed=${failed} totalAmount=${reloaded.totalAmount} paidAmount=${reloaded.paidAmount} allocationSum=${allocSum} ${overpaid || allocMismatch ? "❌ INVARIANT VIOLATED" : "✅ no overpayment, allocations reconcile"}`)
    if (overpaid || allocMismatch) throw new Error("BLOCKER: overpayment or allocation mismatch under concurrency")
    return { succeeded, failed, totalAmount: Number(reloaded.totalAmount), paidAmount: Number(reloaded.paidAmount) }
  }

  async function scenarioRefund(concurrency: number) {
    console.log(`\n--- Refund concurrency (§23): ${concurrency} concurrent completeRefund calls racing the same refund ---`)
    // A dedicated cashier user for this scenario — `openCashierSession`
    // correctly refuses a second concurrent register for the same user
    // (real, correct app behavior, discovered by this script's first draft
    // reusing the shared `session` across every scenario in one process —
    // not a bug), so this scenario needs its own, matching how a real
    // second physical POS terminal would have its own cashier login.
    const refundCashier = await db.user.create({ data: { organizationId: organization.id, email: `p4-5-refund-cashier-${randomUUID()}@load.test`, firstName: "P45", lastName: "RefundCashier", passwordHash: "x" } })
    const refundSession: SessionContext = { ...session, user: { ...session.user, id: refundCashier.id } }

    const charge = await db.$transaction((tx) =>
      generateSystemCharge(tx, { organizationId: organization.id, branchId: branch.id, patientId: patient.id, sourceType: "other", description: "P4.5 refund concurrency", quantity: 1, unitPrice: 100 })
    )
    const invoice = await generateInvoice(refundSession, { patientId: patient.id, branchId: branch.id, chargeIds: [charge.id], discountAmount: 0 })
    const register = await openCashierSession(refundSession, { branchId: branch.id, openingCash: 0 })
    await recordPayment(refundSession, { invoiceId: invoice.id, cashierSessionId: register.id, tenders: [{ method: "cash", amount: 100 }] })
    await dispatchPendingOutboxEvents(organization.id)

    const refund = await requestRefund(refundSession, { invoiceId: invoice.id, method: "cash", amount: 100, reason: "P4.5 load concurrency" })
    await authorizeRefund(refundSession, refund.id)

    const attempts = await Promise.all(Array.from({ length: concurrency }, () => timed(() => completeRefund(refundSession, refund.id, register.id))))
    const succeeded = attempts.filter((a) => !a.error).length
    const failed = attempts.filter((a) => a.error).length
    reportLatency("completeRefund", attempts.map((a) => a.durationMs))

    const reloadedRefund = await db.refund.findUniqueOrThrow({ where: { id: refund.id } })
    const singleCompletion = succeeded === 1 && reloadedRefund.status === "completed"
    console.log(`  succeeded=${succeeded} failed=${failed} finalStatus=${reloadedRefund.status} ${singleCompletion ? "✅ exactly one completion, no double reversal" : "❌ INVARIANT VIOLATED"}`)
    if (!singleCompletion) throw new Error("BLOCKER: refund completed more than once (or zero times) under concurrency")
    return { succeeded, failed, finalStatus: reloadedRefund.status }
  }

  const scenarioArg = process.argv[2] ?? "all"
  const CONCURRENCY = process.argv[3] ? Number(process.argv[3]) : 25

  const scenarios: Record<string, () => Promise<unknown>> = {
    stock: () => scenarioStock(CONCURRENCY),
    invoice: () => scenarioInvoice(CONCURRENCY),
    payment: () => scenarioPayment(CONCURRENCY),
    refund: () => scenarioRefund(Math.min(CONCURRENCY, 10)), // §23: "do not make refunds dominate the normal workload" — a smaller number is appropriate.
  }

  const results: Record<string, unknown> = {}
  const toRun = scenarioArg === "all" ? Object.keys(scenarios) : [scenarioArg]
  for (const name of toRun) {
    if (!scenarios[name]) throw new Error(`Unknown scenario "${name}". Known: ${Object.keys(scenarios).join(", ")}`)
    results[name] = await scenarios[name]()
  }

  console.log("\n" + "=".repeat(70))
  console.log("Write-path concurrency scenarios — ALL INVARIANTS HELD")
  console.log(JSON.stringify(results, null, 2))
  console.log("=".repeat(70))

  await db.$disconnect()
}

main().catch((err) => {
  console.error(`\nwrite-scenarios FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
  process.exit(1)
})
