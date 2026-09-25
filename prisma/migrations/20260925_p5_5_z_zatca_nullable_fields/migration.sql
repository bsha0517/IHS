-- AlterTable
ALTER TABLE "e_invoice_submission" ALTER COLUMN "invoice_type_code" DROP NOT NULL,
ALTER COLUMN "invoice_type_name" DROP NOT NULL,
ALTER COLUMN "uuid" DROP NOT NULL,
ALTER COLUMN "icv" DROP NOT NULL,
ALTER COLUMN "previous_invoice_hash" DROP NOT NULL;
