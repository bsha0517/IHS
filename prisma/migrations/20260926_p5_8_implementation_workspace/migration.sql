-- CreateEnum
CREATE TYPE "ImplementationTrainingStatus" AS ENUM ('not_scheduled', 'scheduled', 'completed', 'not_applicable');

-- AlterTable
ALTER TABLE "organization_commercial_profile" ADD COLUMN     "handover_completed_at" TIMESTAMPTZ(3),
ADD COLUMN     "handover_completed_by_operator_id" TEXT,
ADD COLUMN     "target_go_live_date" DATE;

-- CreateTable
CREATE TABLE "implementation_training" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "status" "ImplementationTrainingStatus" NOT NULL DEFAULT 'not_scheduled',
    "scheduled_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "notes" TEXT,
    "recorded_by_operator_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "implementation_training_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "implementation_note" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "author_operator_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "implementation_note_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "implementation_training_organization_id_idx" ON "implementation_training"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "implementation_training_organization_id_area_key" ON "implementation_training"("organization_id", "area");

-- CreateIndex
CREATE INDEX "implementation_note_organization_id_created_at_idx" ON "implementation_note"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "implementation_training" ADD CONSTRAINT "implementation_training_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "implementation_note" ADD CONSTRAINT "implementation_note_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
