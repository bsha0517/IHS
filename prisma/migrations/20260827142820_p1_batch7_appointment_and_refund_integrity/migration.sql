-- P1 Batch 7, §30: a Refund had no human-readable number at all (every
-- other financial document — Invoice, Payment, GoodsReceipt, SupplierInvoice
-- — already has one). Nullable because it's only assigned once completeRefund
-- actually moves money (see refunds.ts), not at request/authorize time.
ALTER TABLE "refund" ADD COLUMN "refund_number" TEXT;

-- Nullable-safe: Postgres treats every NULL as distinct, so refunds still in
-- "requested"/"authorized"/"rejected" (refund_number still null) never
-- collide with each other under this constraint.
CREATE UNIQUE INDEX "refund_organization_id_refund_number_key" ON "refund"("organization_id", "refund_number");
