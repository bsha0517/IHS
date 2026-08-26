-- DropIndex
DROP INDEX "diagnosis_patient_id_idx";

-- DropIndex
DROP INDEX "follow_up_recommendation_patient_id_status_idx";

-- DropIndex
DROP INDEX "vital_sign_patient_id_recorded_at_idx";

-- AlterTable
ALTER TABLE "diagnosis" ADD COLUMN     "organization_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "follow_up_recommendation" ADD COLUMN     "organization_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "vital_sign" ADD COLUMN     "organization_id" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "diagnosis_organization_id_patient_id_idx" ON "diagnosis"("organization_id", "patient_id");

-- CreateIndex
CREATE INDEX "follow_up_recommendation_organization_id_patient_id_status_idx" ON "follow_up_recommendation"("organization_id", "patient_id", "status");

-- CreateIndex
CREATE INDEX "vital_sign_organization_id_patient_id_recorded_at_idx" ON "vital_sign"("organization_id", "patient_id", "recorded_at");

-- AddForeignKey
ALTER TABLE "vital_sign" ADD CONSTRAINT "vital_sign_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnosis" ADD CONSTRAINT "diagnosis_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up_recommendation" ADD CONSTRAINT "follow_up_recommendation_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

