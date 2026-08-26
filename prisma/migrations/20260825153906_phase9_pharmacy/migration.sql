
-- CreateEnum
CREATE TYPE "DispensingStatus" AS ENUM ('pending', 'verified', 'dispensed', 'cancelled');

-- CreateTable
CREATE TABLE "medication" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "generic_name" TEXT,
    "strength" TEXT,
    "dosage_form" TEXT NOT NULL,
    "route" TEXT,
    "controlled_substance" BOOLEAN NOT NULL DEFAULT false,
    "requires_prescription" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "medication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispensing_record" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "dispensing_number" TEXT NOT NULL,
    "prescription_id" TEXT NOT NULL,
    "prescription_item_id" TEXT NOT NULL,
    "medication_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "quantity_dispensed" INTEGER NOT NULL,
    "status" "DispensingStatus" NOT NULL DEFAULT 'pending',
    "charge_id" TEXT,
    "verified_by" TEXT,
    "verified_at" TIMESTAMPTZ(3),
    "dispensed_by" TEXT,
    "dispensed_at" TIMESTAMPTZ(3),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispensing_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispensing_return" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "dispensing_record_id" TEXT NOT NULL,
    "quantity_returned" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "returned_by" TEXT,
    "returned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispensing_return_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "medication_product_id_key" ON "medication"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "dispensing_record_charge_id_key" ON "dispensing_record"("charge_id");

-- CreateIndex
CREATE INDEX "dispensing_record_organization_id_status_idx" ON "dispensing_record"("organization_id", "status");

-- CreateIndex
CREATE INDEX "dispensing_record_prescription_item_id_idx" ON "dispensing_record"("prescription_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "dispensing_record_organization_id_dispensing_number_key" ON "dispensing_record"("organization_id", "dispensing_number");

-- CreateIndex
CREATE INDEX "dispensing_return_dispensing_record_id_idx" ON "dispensing_return"("dispensing_record_id");

-- AddForeignKey
ALTER TABLE "medication" ADD CONSTRAINT "medication_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medication" ADD CONSTRAINT "medication_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispensing_record" ADD CONSTRAINT "dispensing_record_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispensing_record" ADD CONSTRAINT "dispensing_record_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispensing_record" ADD CONSTRAINT "dispensing_record_prescription_id_fkey" FOREIGN KEY ("prescription_id") REFERENCES "prescription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispensing_record" ADD CONSTRAINT "dispensing_record_prescription_item_id_fkey" FOREIGN KEY ("prescription_item_id") REFERENCES "prescription_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispensing_record" ADD CONSTRAINT "dispensing_record_medication_id_fkey" FOREIGN KEY ("medication_id") REFERENCES "medication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispensing_record" ADD CONSTRAINT "dispensing_record_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispensing_record" ADD CONSTRAINT "dispensing_record_charge_id_fkey" FOREIGN KEY ("charge_id") REFERENCES "charge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispensing_return" ADD CONSTRAINT "dispensing_return_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispensing_return" ADD CONSTRAINT "dispensing_return_dispensing_record_id_fkey" FOREIGN KEY ("dispensing_record_id") REFERENCES "dispensing_record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

