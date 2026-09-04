// npx tsx load-tests/lib/reconcile.ts
//
// P4.5 §42/§43: database invariant verification against `his_load_test` —
// run after any load scenario (or the full mixed/soak/spike run) to prove
// financial, inventory, and accounting invariants held, rather than
// relying only on HTTP success rate (§43's own explicit instruction). Read-
// only, safe to run at any time.

import "dotenv/config"
import { Client } from "pg"
import { assertIsLoadTestDatabase, assertNotRemoteHost, requireEnv } from "../../scripts/db/lib"

const DIRECT_URL = requireEnv("LOAD_TEST_DIRECT_DATABASE_URL")
assertNotRemoteHost(DIRECT_URL, "LOAD_TEST_DIRECT_DATABASE_URL")
assertIsLoadTestDatabase(DIRECT_URL, "LOAD_TEST_DIRECT_DATABASE_URL")

async function main() {
  const client = new Client({ connectionString: DIRECT_URL })
  await client.connect()
  let violations = 0

  console.log("=".repeat(70))
  console.log("P4.5 Reconciliation — his_load_test")
  console.log("=".repeat(70))

  // --- Accounting: overall + per-journal balance -----------------------------
  const overall = await client.query('SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(credit),0) AS c FROM journal_line')
  const d = Number(overall.rows[0].d), c = Number(overall.rows[0].c)
  console.log(`\n[Accounting] Overall: debit=${d.toFixed(2)} credit=${c.toFixed(2)} ${Math.abs(d - c) < 0.01 ? "✅ trial balance balanced" : "❌ UNBALANCED"}`)
  if (Math.abs(d - c) >= 0.01) violations++

  const unbalancedJournals = await client.query(`
    SELECT journal_id, SUM(debit) AS d, SUM(credit) AS c FROM journal_line GROUP BY journal_id HAVING ABS(SUM(debit) - SUM(credit)) > 0.01
  `)
  console.log(`[Accounting] Unbalanced journals: ${unbalancedJournals.rowCount} ${unbalancedJournals.rowCount === 0 ? "✅" : "❌ VIOLATION"}`)
  if ((unbalancedJournals.rowCount ?? 0) > 0) violations++

  // --- Financial: invoice totals vs. (payment allocations − completed refunds) ---
  // A completed Refund reduces Invoice.paidAmount but deliberately does NOT
  // delete/mutate the original PaymentAllocation row (this codebase's own
  // "never delete to reverse a mistake, a reversal is a Refund against it"
  // discipline) — so the correct reconciliation identity is paidAmount ==
  // sum(allocations) − sum(completed refunds), not a bare equality against
  // allocations alone. An earlier version of this script didn't subtract
  // refunds and flagged a false positive on a real, correctly-refunded
  // invoice — fixed here, not a finding about the application.
  const invoiceMismatch = await client.query(`
    WITH alloc AS (
      SELECT invoice_id, SUM(amount) AS alloc_sum FROM payment_allocation GROUP BY invoice_id
    ), refunded AS (
      SELECT invoice_id, SUM(amount) AS refund_sum FROM refund WHERE status = 'completed' GROUP BY invoice_id
    )
    SELECT i.id, i.invoice_number, i.paid_amount,
           COALESCE(alloc.alloc_sum, 0) AS alloc_sum, COALESCE(refunded.refund_sum, 0) AS refund_sum
    FROM invoice i
    LEFT JOIN alloc ON alloc.invoice_id = i.id
    LEFT JOIN refunded ON refunded.invoice_id = i.id
    WHERE ABS(i.paid_amount - (COALESCE(alloc.alloc_sum, 0) - COALESCE(refunded.refund_sum, 0))) > 0.01
    LIMIT 10
  `)
  console.log(`[Financial] Invoices where paidAmount != sum(allocations) − sum(completed refunds): ${invoiceMismatch.rowCount} ${invoiceMismatch.rowCount === 0 ? "✅" : "❌ VIOLATION"}`)
  if ((invoiceMismatch.rowCount ?? 0) > 0) violations++

  const overpaid = await client.query(`SELECT count(*)::int AS n FROM invoice WHERE paid_amount > total_amount + 0.01`)
  console.log(`[Financial] Overpaid invoices (paidAmount > totalAmount): ${overpaid.rows[0].n} ${overpaid.rows[0].n === 0 ? "✅" : "❌ VIOLATION"}`)
  if (overpaid.rows[0].n > 0) violations++

  const duplicateInvoiceLines = await client.query(`
    SELECT charge_id, count(*)::int AS n FROM invoice_line GROUP BY charge_id HAVING count(*) > 1 LIMIT 10
  `)
  console.log(`[Financial] Charges owned by >1 InvoiceLine: ${duplicateInvoiceLines.rowCount} ${duplicateInvoiceLines.rowCount === 0 ? "✅" : "❌ VIOLATION"}`)
  if ((duplicateInvoiceLines.rowCount ?? 0) > 0) violations++

  // --- Inventory: negative stock ------------------------------------------------
  const negativeStock = await client.query(`
    SELECT product_id, batch_id, SUM(quantity) AS balance FROM stock_ledger_entry
    GROUP BY product_id, batch_id HAVING SUM(quantity) < 0 LIMIT 10
  `)
  console.log(`[Inventory] Batches with negative balance: ${negativeStock.rowCount} ${negativeStock.rowCount === 0 ? "✅" : "❌ VIOLATION"}`)
  if ((negativeStock.rowCount ?? 0) > 0) violations++

  // --- Outbox: no invalid stuck rows -----------------------------------------
  const stuckProcessing = await client.query(`
    SELECT count(*)::int AS n FROM outbox_event WHERE status = 'processing' AND last_attempt_at < now() - interval '10 minutes'
  `)
  console.log(`[Outbox] Rows stuck in 'processing' > 10min (should self-heal via the sweep's own stale-recovery): ${stuckProcessing.rows[0].n} ${stuckProcessing.rows[0].n === 0 ? "✅" : "⚠️  present — check whether a sweep has run recently"}`)

  const outboxCounts = await client.query(`SELECT status, count(*)::int AS n FROM outbox_event GROUP BY status ORDER BY status`)
  console.log(`[Outbox] Status breakdown: ${outboxCounts.rows.map((r) => `${r.status}=${r.n}`).join(", ")}`)

  await client.end()

  console.log("\n" + "=".repeat(70))
  if (violations === 0) {
    console.log("✅ ALL INVARIANTS HELD")
  } else {
    console.log(`❌ ${violations} INVARIANT VIOLATION(S) — see above`)
    process.exitCode = 1
  }
  console.log("=".repeat(70))
}

main().catch((err) => {
  console.error(`reconcile failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
