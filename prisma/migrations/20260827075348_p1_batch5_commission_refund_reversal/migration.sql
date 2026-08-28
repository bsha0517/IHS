-- P1 Batch 5 (section 19): nullable CommissionAccrual.refundId — links a
-- negative commission-reversal row back to the refund that caused it (see
-- reverseCommissionsForRefund, commissions.ts, and CommissionAccrual's own
-- schema doc comment).
--
-- The `prisma migrate diff` tool that generated this also re-emitted a
-- redundant OutboxStatus AlterEnum block from P0-02's already-applied
-- migration — every diff run against this schema does this; excluded by
-- hand again here, same as every migration since P0-02.

-- AlterTable
ALTER TABLE "commission_accrual" ADD COLUMN     "refund_id" TEXT;

-- CreateIndex
CREATE INDEX "commission_accrual_refund_id_idx" ON "commission_accrual"("refund_id");

-- AddForeignKey
ALTER TABLE "commission_accrual" ADD CONSTRAINT "commission_accrual_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refund"("id") ON DELETE SET NULL ON UPDATE CASCADE;
