-- P2 Batch 1 (§3, §10, §11, §12) — see P2_REMEDIATION_REPORT.md for the
-- full record. Every addition below is backed by a verified real query
-- pattern or a verified-duplicate-free existing dataset, not blind
-- indexing/constraint-adding — see DATABASE.md's "P2 Remediation Schema
-- Changes, Batch 1" for the evidence behind each one.

-- CreateEnum
CREATE TYPE "PostingIntent" AS ENUM ('cash', 'card', 'bank', 'online', 'insurance', 'credit', 'other', 'accounts_receivable', 'revenue', 'tax_payable', 'unearned_revenue', 'inventory_asset', 'accounts_payable', 'expense_default', 'salary_expense', 'payroll_payable', 'cogs', 'inventory_write_off', 'inventory_adjustment_gain', 'goods_received_not_invoiced', 'recoverable_tax', 'fixed_asset');

-- §10: AccountMapping.intent, String -> PostingIntent. HAND-CORRECTED from
-- Prisma's raw `migrate diff` output, which generated a naive
-- `DROP COLUMN "intent", ADD COLUMN "intent" "PostingIntent" NOT NULL` --
-- that would have destroyed every existing mapping's value instead of
-- converting it. Safe here specifically because every one of the 22
-- distinct existing values was verified against the live database (2026)
-- to exactly match a PostingIntent enum member before this migration was
-- written -- see P2_REMEDIATION_REPORT.md §10 for the verification query
-- and its result.
ALTER TABLE "account_mapping" ALTER COLUMN "intent" TYPE "PostingIntent" USING ("intent"::text::"PostingIntent");

-- §3: widened from a bare branchId index -- see DATABASE.md for the real
-- query (listEncounters/listOrders) each of these two DropIndex/CreateIndex
-- pairs replaces.
DROP INDEX "encounter_branch_id_idx";

DROP INDEX "clinical_order_branch_id_idx";

-- §12: updatedAt on Charge/Invoice/Payment (mutable financial records --
-- see P2_FINDINGS.md §12). HAND-CORRECTED: Prisma's raw diff omitted a
-- backfill default, which would fail outright against the existing rows in
-- these three tables. DEFAULT CURRENT_TIMESTAMP backfills every existing
-- row to "updated now" (a reasonable, honest value -- there is no better
-- historical answer for "when was this row last changed" than "unknown,
-- treat as now" for data that predates this column); every write from here
-- forward sets a real value via Prisma's own `@updatedAt` behavior.
ALTER TABLE "charge" ADD COLUMN "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "invoice" ADD COLUMN "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "payment" ADD COLUMN "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- §11: composite org-scoped uniqueness -- both verified duplicate-free
-- against the live database before this migration was written (see
-- P2_REMEDIATION_REPORT.md §11). NULL stays distinct per Postgres's usual
-- unique-index semantics, so rows with no username/licenseNumber set never
-- collide with each other.
CREATE UNIQUE INDEX "user_organization_id_username_key" ON "user"("organization_id", "username");

CREATE UNIQUE INDEX "provider_organization_id_license_number_key" ON "provider"("organization_id", "license_number");

-- §3: real query patterns only -- see DATABASE.md's "P2 Remediation Schema
-- Changes, Batch 1" for the specific function/report each index below
-- supports. None added merely because a foreign key exists.
CREATE INDEX "patient_organization_id_created_at_idx" ON "patient"("organization_id", "created_at");

CREATE INDEX "episode_branch_id_start_date_idx" ON "episode"("branch_id", "start_date");

CREATE INDEX "encounter_branch_id_start_at_idx" ON "encounter"("branch_id", "start_at");

CREATE INDEX "clinical_order_branch_id_ordered_at_idx" ON "clinical_order"("branch_id", "ordered_at");

CREATE INDEX "charge_organization_id_created_at_idx" ON "charge"("organization_id", "created_at");

CREATE INDEX "invoice_organization_id_issued_at_idx" ON "invoice"("organization_id", "issued_at");

CREATE INDEX "invoice_organization_id_created_at_idx" ON "invoice"("organization_id", "created_at");

CREATE INDEX "payment_organization_id_received_at_idx" ON "payment"("organization_id", "received_at");

CREATE INDEX "stock_ledger_entry_organization_id_branch_id_created_at_idx" ON "stock_ledger_entry"("organization_id", "branch_id", "created_at");

CREATE INDEX "goods_receipt_organization_id_branch_id_received_at_idx" ON "goods_receipt"("organization_id", "branch_id", "received_at");

CREATE INDEX "supplier_invoice_organization_id_created_at_idx" ON "supplier_invoice"("organization_id", "created_at");

-- Note: no CREATE INDEX needed for account_mapping's existing
-- (organizationId, intent, branchId) index -- Postgres's ALTER COLUMN ...
-- TYPE above rebuilds any index depending on that column in place, under
-- the same name, automatically. Prisma's raw diff emitted a redundant
-- CREATE INDEX here (with no matching DROP first) that collided with the
-- still-existing index and was removed by hand -- caught by the first
-- application attempt failing with "relation already exists", not
-- discovered as a silent problem later.
CREATE INDEX "commission_accrual_organization_id_provider_id_accrued_at_idx" ON "commission_accrual"("organization_id", "provider_id", "accrued_at");

CREATE INDEX "claim_organization_id_created_at_idx" ON "claim"("organization_id", "created_at");
