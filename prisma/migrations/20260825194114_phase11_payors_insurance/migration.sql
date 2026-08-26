
-- CreateEnum
CREATE TYPE "PayorType" AS ENUM ('self_pay', 'insurance_company', 'corporate', 'government', 'other');

-- CreateEnum
CREATE TYPE "CoverageStatus" AS ENUM ('active', 'inactive', 'expired');

-- CreateEnum
CREATE TYPE "AuthorizationStatus" AS ENUM ('requested', 'approved', 'denied', 'expired');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('draft', 'submitted', 'adjudicated', 'rejected', 'remitted', 'void');

-- AlterTable
ALTER TABLE "invoice" ADD COLUMN     "estimated_patient_responsibility" DECIMAL(14,2),
ADD COLUMN     "estimated_payor_responsibility" DECIMAL(14,2),
ADD COLUMN     "final_patient_responsibility" DECIMAL(14,2),
ADD COLUMN     "final_payor_responsibility" DECIMAL(14,2),
ADD COLUMN     "patient_coverage_id" TEXT,
ADD COLUMN     "payor_id" TEXT;

-- AlterTable
ALTER TABLE "payment" ADD COLUMN     "claim_id" TEXT;

-- CreateTable
CREATE TABLE "payor" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "payor_type" "PayorType" NOT NULL,
    "contact_name" TEXT,
    "contact_phone" TEXT,
    "contact_email" TEXT,
    "address" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_plan" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "payor_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "insurance_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "insurance_plan_id" TEXT NOT NULL,
    "policy_number" TEXT NOT NULL,
    "group_number" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_coverage" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "relationship_to_subscriber" TEXT NOT NULL DEFAULT 'self',
    "start_date" TIMESTAMPTZ(3) NOT NULL,
    "end_date" TIMESTAMPTZ(3),
    "copay_amount" DECIMAL(14,2),
    "copay_percent" DECIMAL(5,2),
    "deductible_amount" DECIMAL(14,2),
    "annual_limit_amount" DECIMAL(14,2),
    "is_primary" BOOLEAN NOT NULL DEFAULT true,
    "status" "CoverageStatus" NOT NULL DEFAULT 'active',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "patient_coverage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prior_authorization" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "patient_coverage_id" TEXT NOT NULL,
    "encounter_id" TEXT,
    "auth_number" TEXT,
    "status" "AuthorizationStatus" NOT NULL DEFAULT 'requested',
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(3),
    "valid_from" TIMESTAMPTZ(3),
    "valid_until" TIMESTAMPTZ(3),
    "notes" TEXT,
    "requested_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prior_authorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "claim_number" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "patient_coverage_id" TEXT NOT NULL,
    "payor_id" TEXT NOT NULL,
    "encounter_id" TEXT,
    "invoice_id" TEXT NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'draft',
    "submitted_amount" DECIMAL(14,2) NOT NULL,
    "approved_amount" DECIMAL(14,2),
    "rejected_amount" DECIMAL(14,2),
    "patient_responsibility_amount" DECIMAL(14,2),
    "rejection_reason" TEXT,
    "external_reference" TEXT,
    "submitted_at" TIMESTAMPTZ(3),
    "adjudicated_at" TIMESTAMPTZ(3),
    "remitted_at" TIMESTAMPTZ(3),
    "resubmission_of_id" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_item" (
    "id" TEXT NOT NULL,
    "claim_id" TEXT NOT NULL,
    "invoice_line_id" TEXT NOT NULL,
    "diagnosis_id" TEXT,
    "procedure_code" TEXT,
    "submitted_amount" DECIMAL(14,2) NOT NULL,
    "approved_amount" DECIMAL(14,2),
    "rejected_amount" DECIMAL(14,2),
    "denial_reason" TEXT,

    CONSTRAINT "claim_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payor_organization_id_code_key" ON "payor"("organization_id", "code");

-- CreateIndex
CREATE INDEX "insurance_plan_payor_id_idx" ON "insurance_plan"("payor_id");

-- CreateIndex
CREATE UNIQUE INDEX "insurance_plan_organization_id_code_key" ON "insurance_plan"("organization_id", "code");

-- CreateIndex
CREATE INDEX "policy_insurance_plan_id_idx" ON "policy"("insurance_plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "policy_organization_id_policy_number_key" ON "policy"("organization_id", "policy_number");

-- CreateIndex
CREATE INDEX "patient_coverage_organization_id_patient_id_idx" ON "patient_coverage"("organization_id", "patient_id");

-- CreateIndex
CREATE INDEX "prior_authorization_organization_id_patient_id_idx" ON "prior_authorization"("organization_id", "patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "claim_resubmission_of_id_key" ON "claim"("resubmission_of_id");

-- CreateIndex
CREATE INDEX "claim_organization_id_status_idx" ON "claim"("organization_id", "status");

-- CreateIndex
CREATE INDEX "claim_invoice_id_idx" ON "claim"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "claim_organization_id_claim_number_key" ON "claim"("organization_id", "claim_number");

-- CreateIndex
CREATE INDEX "claim_item_claim_id_idx" ON "claim_item"("claim_id");

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_payor_id_fkey" FOREIGN KEY ("payor_id") REFERENCES "payor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_patient_coverage_id_fkey" FOREIGN KEY ("patient_coverage_id") REFERENCES "patient_coverage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claim"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payor" ADD CONSTRAINT "payor_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_plan" ADD CONSTRAINT "insurance_plan_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_plan" ADD CONSTRAINT "insurance_plan_payor_id_fkey" FOREIGN KEY ("payor_id") REFERENCES "payor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy" ADD CONSTRAINT "policy_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy" ADD CONSTRAINT "policy_insurance_plan_id_fkey" FOREIGN KEY ("insurance_plan_id") REFERENCES "insurance_plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_coverage" ADD CONSTRAINT "patient_coverage_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_coverage" ADD CONSTRAINT "patient_coverage_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_coverage" ADD CONSTRAINT "patient_coverage_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prior_authorization" ADD CONSTRAINT "prior_authorization_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prior_authorization" ADD CONSTRAINT "prior_authorization_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prior_authorization" ADD CONSTRAINT "prior_authorization_patient_coverage_id_fkey" FOREIGN KEY ("patient_coverage_id") REFERENCES "patient_coverage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prior_authorization" ADD CONSTRAINT "prior_authorization_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim" ADD CONSTRAINT "claim_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim" ADD CONSTRAINT "claim_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim" ADD CONSTRAINT "claim_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim" ADD CONSTRAINT "claim_patient_coverage_id_fkey" FOREIGN KEY ("patient_coverage_id") REFERENCES "patient_coverage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim" ADD CONSTRAINT "claim_payor_id_fkey" FOREIGN KEY ("payor_id") REFERENCES "payor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim" ADD CONSTRAINT "claim_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim" ADD CONSTRAINT "claim_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim" ADD CONSTRAINT "claim_resubmission_of_id_fkey" FOREIGN KEY ("resubmission_of_id") REFERENCES "claim"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_item" ADD CONSTRAINT "claim_item_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_item" ADD CONSTRAINT "claim_item_invoice_line_id_fkey" FOREIGN KEY ("invoice_line_id") REFERENCES "invoice_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_item" ADD CONSTRAINT "claim_item_diagnosis_id_fkey" FOREIGN KEY ("diagnosis_id") REFERENCES "diagnosis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

