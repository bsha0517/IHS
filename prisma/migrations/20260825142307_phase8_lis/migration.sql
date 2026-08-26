
-- CreateEnum
CREATE TYPE "LabResultType" AS ENUM ('numeric', 'text');

-- CreateEnum
CREATE TYPE "SpecimenStatus" AS ENUM ('pending', 'collected', 'received', 'rejected');

-- CreateEnum
CREATE TYPE "LabOrderTestStatus" AS ENUM ('ordered', 'collected', 'processing', 'resulted', 'verified', 'cancelled');

-- CreateEnum
CREATE TYPE "AbnormalFlag" AS ENUM ('normal', 'low', 'high', 'critical_low', 'critical_high');

-- CreateTable
CREATE TABLE "lab_test" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "specimen_type" TEXT NOT NULL,
    "result_type" "LabResultType" NOT NULL,
    "unit" TEXT,
    "reference_range_low" DECIMAL(10,3),
    "reference_range_high" DECIMAL(10,3),
    "reference_range_text" TEXT,
    "price" DECIMAL(14,2) NOT NULL,
    "turnaround_hours" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "lab_test_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_panel" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(14,2) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lab_panel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_panel_test" (
    "id" TEXT NOT NULL,
    "lab_panel_id" TEXT NOT NULL,
    "lab_test_id" TEXT NOT NULL,

    CONSTRAINT "lab_panel_test_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specimen" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "clinical_order_id" TEXT NOT NULL,
    "specimen_number" TEXT NOT NULL,
    "specimen_type" TEXT NOT NULL,
    "status" "SpecimenStatus" NOT NULL DEFAULT 'pending',
    "collected_by" TEXT,
    "collected_at" TIMESTAMPTZ(3),
    "rejection_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "specimen_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_order_test" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "clinical_order_id" TEXT NOT NULL,
    "lab_test_id" TEXT NOT NULL,
    "lab_panel_id" TEXT,
    "specimen_id" TEXT,
    "charge_id" TEXT,
    "status" "LabOrderTestStatus" NOT NULL DEFAULT 'ordered',
    "result_type" "LabResultType" NOT NULL,
    "numeric_value" DECIMAL(10,3),
    "text_value" TEXT,
    "unit" TEXT,
    "reference_range_low" DECIMAL(10,3),
    "reference_range_high" DECIMAL(10,3),
    "reference_range_text" TEXT,
    "abnormal_flag" "AbnormalFlag",
    "entered_by" TEXT,
    "entered_at" TIMESTAMPTZ(3),
    "verified_by" TEXT,
    "verified_at" TIMESTAMPTZ(3),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lab_order_test_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lab_test_organization_id_category_idx" ON "lab_test"("organization_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "lab_test_organization_id_code_key" ON "lab_test"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "lab_panel_organization_id_code_key" ON "lab_panel"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "lab_panel_test_lab_panel_id_lab_test_id_key" ON "lab_panel_test"("lab_panel_id", "lab_test_id");

-- CreateIndex
CREATE INDEX "specimen_clinical_order_id_idx" ON "specimen"("clinical_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "specimen_organization_id_specimen_number_key" ON "specimen"("organization_id", "specimen_number");

-- CreateIndex
CREATE UNIQUE INDEX "lab_order_test_charge_id_key" ON "lab_order_test"("charge_id");

-- CreateIndex
CREATE INDEX "lab_order_test_organization_id_status_idx" ON "lab_order_test"("organization_id", "status");

-- CreateIndex
CREATE INDEX "lab_order_test_clinical_order_id_idx" ON "lab_order_test"("clinical_order_id");

-- AddForeignKey
ALTER TABLE "lab_test" ADD CONSTRAINT "lab_test_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_panel" ADD CONSTRAINT "lab_panel_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_panel_test" ADD CONSTRAINT "lab_panel_test_lab_panel_id_fkey" FOREIGN KEY ("lab_panel_id") REFERENCES "lab_panel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_panel_test" ADD CONSTRAINT "lab_panel_test_lab_test_id_fkey" FOREIGN KEY ("lab_test_id") REFERENCES "lab_test"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specimen" ADD CONSTRAINT "specimen_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specimen" ADD CONSTRAINT "specimen_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specimen" ADD CONSTRAINT "specimen_clinical_order_id_fkey" FOREIGN KEY ("clinical_order_id") REFERENCES "clinical_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_order_test" ADD CONSTRAINT "lab_order_test_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_order_test" ADD CONSTRAINT "lab_order_test_clinical_order_id_fkey" FOREIGN KEY ("clinical_order_id") REFERENCES "clinical_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_order_test" ADD CONSTRAINT "lab_order_test_lab_test_id_fkey" FOREIGN KEY ("lab_test_id") REFERENCES "lab_test"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_order_test" ADD CONSTRAINT "lab_order_test_lab_panel_id_fkey" FOREIGN KEY ("lab_panel_id") REFERENCES "lab_panel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_order_test" ADD CONSTRAINT "lab_order_test_specimen_id_fkey" FOREIGN KEY ("specimen_id") REFERENCES "specimen"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_order_test" ADD CONSTRAINT "lab_order_test_charge_id_fkey" FOREIGN KEY ("charge_id") REFERENCES "charge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

