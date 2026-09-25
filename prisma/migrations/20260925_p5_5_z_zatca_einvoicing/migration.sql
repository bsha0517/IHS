-- CreateEnum
CREATE TYPE "EInvoiceSubmissionStatus" AS ENUM ('not_configured', 'pending', 'reported', 'cleared', 'rejected', 'failed');

-- CreateTable
CREATE TABLE "e_invoice_submission" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "invoice_type_code" TEXT NOT NULL,
    "invoice_type_name" TEXT NOT NULL,
    "uuid" TEXT NOT NULL,
    "icv" INTEGER NOT NULL,
    "previous_invoice_hash" TEXT NOT NULL,
    "invoice_hash" TEXT,
    "qr_code" TEXT,
    "xml_content" TEXT,
    "status" "EInvoiceSubmissionStatus" NOT NULL DEFAULT 'not_configured',
    "zatca_status" TEXT,
    "warnings" JSONB,
    "errors" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMPTZ(3),
    "submitted_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "e_invoice_submission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "e_invoice_submission_invoice_id_key" ON "e_invoice_submission"("invoice_id");

-- CreateIndex
CREATE INDEX "e_invoice_submission_organization_id_status_idx" ON "e_invoice_submission"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "e_invoice_submission_organization_id_icv_key" ON "e_invoice_submission"("organization_id", "icv");

-- AddForeignKey
ALTER TABLE "e_invoice_submission" ADD CONSTRAINT "e_invoice_submission_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "e_invoice_submission" ADD CONSTRAINT "e_invoice_submission_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
