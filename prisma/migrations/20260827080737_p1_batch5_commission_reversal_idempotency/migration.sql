-- P1 Batch 5 follow-up (section 19): a real DB integration test caught a
-- genuine idempotency bug in the previous migration's design — checking
-- only (refundId, chargeId) for an existing reversal row silently
-- under-reverses when one charge has multiple originating payments (so
-- multiple collected_revenue accruals to reverse for the same refund):
-- the second payment's reversal was wrongly treated as "already done" once
-- the first payment's reversal existed. `reversalOfId` (which ORIGINAL
-- accrual this row reverses) plus a real @@unique([refundId, reversalOfId])
-- constraint is the precise, DB-enforced fix — see CommissionAccrual's own
-- schema doc comment and reverseCommissionsForRefund (commissions.ts).
--
-- The `prisma migrate diff` tool that generated this also re-emitted a
-- redundant OutboxStatus AlterEnum block from P0-02's already-applied
-- migration — every diff run against this schema does this; excluded by
-- hand again here, same as every migration since P0-02.

-- AlterTable
ALTER TABLE "commission_accrual" ADD COLUMN     "reversal_of_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "commission_accrual_refund_id_reversal_of_id_key" ON "commission_accrual"("refund_id", "reversal_of_id");

-- AddForeignKey
ALTER TABLE "commission_accrual" ADD CONSTRAINT "commission_accrual_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "commission_accrual"("id") ON DELETE SET NULL ON UPDATE CASCADE;
