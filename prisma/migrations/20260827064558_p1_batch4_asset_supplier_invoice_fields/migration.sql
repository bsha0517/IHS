-- P1 Batch 4 (sections 15/17): Asset depreciation-readiness + paidVia
-- fields, and SupplierInvoice.taxAmount for recoverable purchase tax.
--
-- The `prisma migrate diff` tool that generated this also re-emitted a
-- redundant OutboxStatus AlterEnum block (drop/recreate the enum with the
-- exact same values) from P0-02's already-applied migration — every diff
-- run against this schema does this; excluded by hand again here, same as
-- every migration since P0-02.

-- AlterTable
ALTER TABLE "asset" ADD COLUMN     "depreciation_method" TEXT,
ADD COLUMN     "depreciation_start_date" DATE,
ADD COLUMN     "paid_via" "PaymentMethod",
ADD COLUMN     "salvage_value" DECIMAL(14,2),
ADD COLUMN     "useful_life_months" INTEGER;

-- AlterTable
ALTER TABLE "supplier_invoice" ADD COLUMN     "tax_amount" DECIMAL(14,2) NOT NULL DEFAULT 0;
