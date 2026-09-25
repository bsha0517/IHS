-- DropForeignKey
ALTER TABLE "e_invoice_submission" DROP CONSTRAINT "e_invoice_submission_invoice_id_fkey";

-- AddForeignKey
ALTER TABLE "e_invoice_submission" ADD CONSTRAINT "e_invoice_submission_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
