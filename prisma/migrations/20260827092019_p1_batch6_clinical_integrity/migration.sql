-- P1 Batch 6 (sections 20-25): lab order/result state integrity, critical
-- abnormal flags, clinical-order/encounter cancellation reasons.
--
-- The `prisma migrate diff` tool that generated this also re-emitted a
-- redundant OutboxStatus AlterEnum block from P0-02's already-applied
-- migration — every diff run against this schema does this; excluded by
-- hand again here, same as every migration since P0-02.

-- AlterEnum: adding enum values must run outside a transaction block, and
-- (Postgres restriction) cannot be used in the same transaction that adds
-- them — not a concern here since nothing in this migration references
-- these new values.
ALTER TYPE "EncounterStatus" ADD VALUE 'cancelled';
ALTER TYPE "EncounterStatus" ADD VALUE 'entered_in_error';

-- AlterTable
ALTER TABLE "clinical_order" ADD COLUMN     "cancel_reason" TEXT;

-- AlterTable
ALTER TABLE "encounter" ADD COLUMN     "cancel_reason" TEXT;

-- AlterTable
ALTER TABLE "lab_order_test" ADD COLUMN     "amends_id" TEXT,
ADD COLUMN     "is_current" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "lab_test" ADD COLUMN     "critical_high" DECIMAL(10,3),
ADD COLUMN     "critical_low" DECIMAL(10,3);

-- AddForeignKey
ALTER TABLE "lab_order_test" ADD CONSTRAINT "lab_order_test_amends_id_fkey" FOREIGN KEY ("amends_id") REFERENCES "lab_order_test"("id") ON DELETE SET NULL ON UPDATE CASCADE;
