# INVENTORY.md

Living reference for inventory accounting — valuation method, cost basis, and how physical stock movement connects to the general ledger. Created in the P1 remediation pass (Batch 3, §9-§13, 2026-08-27) alongside the work that made this connection real for the first time; see P1_FINANCIAL_INTEGRITY_FINDINGS.md's B1-B5 for the gaps this closes and P1_REMEDIATION_REPORT.md for the full batch record.

## 1. Physical Allocation vs. Accounting Valuation (P1 §12)

These are two different questions this system answers two different ways, and P1.md was explicit that FEFO answering the first does not automatically answer the second:

- **"Which physical unit gets consumed first?"** — FEFO (First-Expired-First-Out). `consumeStock` (`src/lib/domains/inventory/stock.ts`) walks batches ordered by expiry date ascending (nulls last), excluding expired batches entirely (P0-03). This is a *physical allocation* policy — it decides which box comes off the shelf, nothing about its cost.
- **"What did the unit that left the shelf actually cost?"** — **Specific identification, at the batch level.** Every `ProductBatch` already carries its own `purchaseCost`, captured as a real, exact figure at goods-receipt time (`receiveStock`, same file) — not estimated, not averaged. Because FEFO already tells `consumeStock` exactly which batch(es) a consumption drew from, valuing that consumption at those batches' own actual cost requires no new data and no new estimation scheme — it is simply reading back the cost this system already recorded when the stock arrived.

## 2. Why Specific Identification, Not FIFO or Moving Average

FIFO (as a distinct accounting method from FEFO's physical-allocation role) and moving-weighted-average both exist to answer "what did this unit cost?" when a system *doesn't* know which specific physical unit was consumed. This system does know — FEFO's own batch selection *is* the specific-identification event. Introducing a separate FIFO cost-layer ledger or a recomputed moving average on top of that would be:

- **Redundant** — it would re-derive an answer this system's existing schema already has, from `ProductBatch.purchaseCost`.
- **A new, previously-nonexistent data structure** — Phase 5 never built FIFO cost layers or a running weighted-average recalculation on `Product.purchaseCost`; adding either now would be new infrastructure invented for this pass, not a coherent model already present in the schema (which P1 §12 explicitly warns against).

`Product.purchaseCost` (a single field on the product master) still exists and still has a real, narrower role — see §4 below.

## 3. Where This Is Implemented

| What | Where | Cost basis used |
|---|---|---|
| POS product sale stock consumption | `consumeStock` (`inventory/stock.ts`), called from `insertCharge` (`billing/charges.ts`) when a charge carries a real `productId` | Batch-specific `purchaseCost`, summed across whichever batch(es) FEFO allocated to satisfy the quantity |
| COGS journal for a product sale | `postProductSaleCogs` (`accounting/posting-service.ts`), fired by the `ProductSold` outbox event | The exact `totalCost` `consumeStock` computed and returned — never recomputed or re-estimated downstream |
| Voiding a product-sale charge | `voidCharge` (`billing/charges.ts`) + `postProductSaleVoided` | Mirrors the original COGS journal's own posted amount exactly, not a fresh calculation |
| Stock valuation report | `getInventoryReport` (`analytics/reports/inventory.ts`) | Sums each product's batches' remaining positive balance × that batch's own `purchaseCost` — the identical basis as the row above, so the two can never silently disagree |
| Damage/expiry write-off, or any manual count-correction gain/loss | `postInventoryAdjustment`, fired from `recordAdjustment` (`inventory/stock.ts`) | The specific batch's own `purchaseCost` — always, since P2 §5 (2026-08-29) made a real batch mandatory in both directions; see §4 below for the one remaining place `Product.purchaseCost` still feeds this |
| Pharmacy dispensing stock consumption | `consumeStock` (`inventory/stock.ts`), called directly from `dispenseRecord` (`pharmacy/dispensing.ts`) | Batch-specific `purchaseCost`, identical mechanism to the POS row above |
| COGS journal for a dispensed medication | `postProductSaleCogs`, fired by the same `ProductSold` outbox event `dispenseRecord` now writes (P1 Batch 4, §14) | Reuses the POS row's exact posting function — no separate "pharmacy COGS" was built |

## 4. `Product.purchaseCost`'s Remaining Role

`Product.purchaseCost` is not used for COGS or the valuation report's primary figure anymore (§3 corrected this — see PROJECT_STATUS.md's Phase 13 Known Issues for the prior state, which explicitly flagged this exact mismatch as a documented simplification). It still serves two narrower, legitimate purposes:

1. **Default cost for a brand-new product** before any goods receipt has ever happened for it — there is no batch yet to be specific about.
2. **Default cost for a batch created inline by a manual adjustment** (`recordAdjustment`, `direction: "in"`, an existing batch not selected) when the person recording the adjustment doesn't supply one of their own — see §5's "Batch-Aware Manual Adjustments" below. Before P2 §5 (2026-08-29) this was a *ledger-entry-level* fallback (a batch-less adjustment valued at the product's cost); it is now a *batch-creation-level* fallback (the new batch's own `purchaseCost` column defaults to the product's, then behaves exactly like any other batch from then on) — the ledger entry itself is never batch-less.

Both are real, narrow gaps in what specific identification can answer, not a parallel valuation system — the moment a batch is genuinely known, its own cost is what's used.

## 5. Batch-Aware Manual Adjustments (P2 §5, 2026-08-29)

`recordAdjustment` (`inventory/stock.ts`) is the only user-facing way to move stock outside a receipt/transfer/consumption. Before this pass it was batch-optional in both directions — the UI never asked for one — so a manual adjustment could post a batch-less ledger entry even though every other path stock moves through (`receiveStock`, `consumeStock`, transfers) always ties the movement to a real `ProductBatch`. See P2_FINDINGS.md §5 and P2_REMEDIATION_REPORT.md's Batch 4 section for the full evidence and implementation record. Closed in both directions:

- **Reduction (`direction: "out"`)** — always removes from one specific, already-existing batch. `batchId` is required by `stockAdjustmentSchema`'s own refinement, and re-verified server-side (belongs to this product/org, has enough balance at this branch) inside the same transaction as the write. The batch selector deliberately includes *expired* batches, unlike `consumeStock`'s FEFO-allocatable pool (§1 above) — writing off expired stock is a named, expected use of this path, not something FEFO exclusion should also block for a direct, staff-initiated correction.
- **Addition (`direction: "in"`)** — either adds to an existing batch (`batchId`) or creates one inline, in the same transaction as the ledger entry (`newBatchNumber` + optional expiry/manufacturing/cost). A `newBatchNumber` matching one already on file for this product is treated as selecting that batch (`ProductBatch.@@unique([productId, batchNumber])` makes this an upsert-by-number, not a duplicate-key error).

Either way, the ledger entry always carries a real `batchId` — batch-level stock (the SUM of that batch's own `StockLedgerEntry` rows) and the product's overall stock ledger can never diverge, because they were never two different things to begin with. An optional external reference (a count sheet or damage report number, distinct from the required `reason` narrative) is stored on the ledger entry's existing `referenceType`/`referenceId` polymorphic pointer (`referenceType: "manual_adjustment"`) — the same columns `StockTransfer` completion already uses for its own reference, just previously never populated by a manual adjustment. FEFO consumption itself (`allocateFefo`/`consumeStock`/§1 above) is untouched by this work.

## 6. What Was Deliberately Not Built

- **Batch-level cost layers with automatic depletion accounting** (a full perpetual FIFO/LIFO ledger) — not needed; `ProductBatch.purchaseCost` combined with FEFO's own batch selection already gives an exact answer without one.
- **Automatic recalculation of `Product.purchaseCost` as a moving average on every goods receipt** — would have been new infrastructure serving a valuation method this system doesn't use (see §2); `Product.purchaseCost` stays a simple, manually-set master-data default.
- **Accounting treatment for `return`-type manual adjustments** (P1 §13) — `recordAdjustment`'s `return` transaction type moves inventory without posting an accounting entry, on purpose: a manual "return to stock" has no single original transaction this function can identify to reverse, and guessing at one risks a wrong entry. This stays inventory-only until a real workflow (e.g. a return tied to a specific original sale/dispensing record, the way pharmacy's `returnDispensingRecord` already handles its own domain) names what it should actually reverse.
- **Service-triggered automatic consumption's own COGS** (`ServiceProductConsumption` templates, Phase 5 — e.g. "Wound Dressing consumes 2× Gauze") — this batch's COGS work is scoped to direct retail product sales (P1 §11's literal wording), not the cost of supplies consumed in delivering a *service*, which is a related but distinct question (arguably already reflected in the service's own price margin) not asked for in this pass.
- **Reversing a dispensed medication's COGS on return** (P1 Batch 4, §14) — `returnDispensingRecord` adds stock back (its own `return`-type ledger entry, same treatment as the point above) but deliberately does not reverse the original `postProductSaleCogs` journal, consistent with it also not reversing the original Charge: a return is a physical stock correction to an otherwise-final sale, not an undo of that sale's financials. Contrast this with `voidCharge`'s POS-side `postProductSaleVoided`, which genuinely does reverse both — the difference is that voiding only ever happens to a still-`pending`, never-invoiced charge, while a dispensing return happens well after the charge (and its invoice) are already final.

## 7. Reconciliation Proof (P1 §35, Batch 9)

Everything above was design reasoning until Batch 9's `test/integration/report-reconciliation.test.ts` proved it against a real transaction chain rather than leaving it as an argument: receiving 50 units at 10 each, then selling 20, moves `getInventoryReport()`'s own valuation figure by exactly the same amounts (+500, then -200) as the GL's Inventory Asset account — the precise "stock decreases, COGS posted, valuation must decrease consistently" identity P1 §35 names as its own literal example. See P1_REMEDIATION_REPORT.md §35 and SYSTEM_INTEGRITY_MATRIX.md's Product Sale/Goods Receipt rows for the full evidence chain, and this pass's final response (Question C) for the exact numbers.
