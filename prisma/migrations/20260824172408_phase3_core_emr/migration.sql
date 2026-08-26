-- CreateEnum
CREATE TYPE "EpisodeStatus" AS ENUM ('open', 'active', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "EncounterType" AS ENUM ('consultation', 'follow_up', 'procedure', 'therapy', 'emergency_walk_in', 'diagnostic', 'teleconsultation');

-- CreateEnum
CREATE TYPE "EncounterStatus" AS ENUM ('draft', 'active', 'completed', 'finalized');

-- CreateEnum
CREATE TYPE "DiagnosisStatus" AS ENUM ('active', 'resolved', 'ruled_out');

-- CreateEnum
CREATE TYPE "ClinicalNoteType" AS ENUM ('consultation', 'progress', 'nursing', 'procedure', 'follow_up');

-- CreateEnum
CREATE TYPE "ClinicalNoteStatus" AS ENUM ('draft', 'finalized');

-- CreateEnum
CREATE TYPE "ClinicalOrderType" AS ENUM ('lab', 'imaging', 'procedure', 'referral', 'other');

-- CreateEnum
CREATE TYPE "ClinicalOrderPriority" AS ENUM ('routine', 'urgent', 'stat');

-- CreateEnum
CREATE TYPE "ClinicalOrderStatus" AS ENUM ('draft', 'ordered', 'acknowledged', 'in_progress', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "ReferralScope" AS ENUM ('internal', 'external');

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('issued', 'acknowledged', 'seen', 'closed');

-- CreateEnum
CREATE TYPE "PrescriptionStatus" AS ENUM ('active', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "FollowUpStatus" AS ENUM ('open', 'scheduled', 'dismissed');

-- CreateTable
CREATE TABLE "episode" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "episode_number" TEXT NOT NULL,
    "episode_type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "primary_provider_id" TEXT,
    "status" "EpisodeStatus" NOT NULL DEFAULT 'open',
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "episode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "encounter" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "department_id" TEXT,
    "patient_id" TEXT NOT NULL,
    "episode_id" TEXT,
    "appointment_id" TEXT,
    "provider_id" TEXT NOT NULL,
    "encounter_number" TEXT NOT NULL,
    "encounter_type" "EncounterType" NOT NULL DEFAULT 'consultation',
    "start_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "end_at" TIMESTAMPTZ(3),
    "status" "EncounterStatus" NOT NULL DEFAULT 'draft',
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "encounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vital_sign" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "encounter_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "recorded_by" TEXT,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "height_cm" DECIMAL(6,2),
    "weight_kg" DECIMAL(6,2),
    "bmi" DECIMAL(5,2),
    "blood_pressure_systolic" INTEGER,
    "blood_pressure_diastolic" INTEGER,
    "pulse_bpm" INTEGER,
    "temperature_celsius" DECIMAL(4,1),
    "oxygen_saturation_percent" INTEGER,
    "respiratory_rate_per_min" INTEGER,
    "blood_glucose_mg_dl" DECIMAL(6,2),

    CONSTRAINT "vital_sign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnosis_code" (
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "diagnosis_code_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "diagnosis" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "encounter_id" TEXT NOT NULL,
    "episode_id" TEXT,
    "diagnosis_code" TEXT,
    "description" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "status" "DiagnosisStatus" NOT NULL DEFAULT 'active',
    "diagnosed_by" TEXT,
    "diagnosed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diagnosis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical_note" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "encounter_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "note_type" "ClinicalNoteType" NOT NULL,
    "status" "ClinicalNoteStatus" NOT NULL DEFAULT 'draft',
    "chief_complaint" TEXT,
    "history_of_present_illness" TEXT,
    "review_of_systems" TEXT,
    "examination_findings" TEXT,
    "assessment" TEXT,
    "treatment_plan" TEXT,
    "content" TEXT,
    "amends_id" TEXT,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "authored_by" TEXT,
    "finalized_by" TEXT,
    "finalized_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "clinical_note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical_order" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "encounter_id" TEXT NOT NULL,
    "order_number" TEXT NOT NULL,
    "order_type" "ClinicalOrderType" NOT NULL,
    "priority" "ClinicalOrderPriority" NOT NULL DEFAULT 'routine',
    "instructions" TEXT,
    "status" "ClinicalOrderStatus" NOT NULL DEFAULT 'draft',
    "ordering_provider_id" TEXT NOT NULL,
    "ordered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "clinical_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_order_detail" (
    "clinical_order_id" TEXT NOT NULL,
    "test_name" TEXT NOT NULL,
    "specimen_type" TEXT,
    "clinical_notes" TEXT,

    CONSTRAINT "lab_order_detail_pkey" PRIMARY KEY ("clinical_order_id")
);

-- CreateTable
CREATE TABLE "imaging_order_detail" (
    "clinical_order_id" TEXT NOT NULL,
    "imaging_type" TEXT NOT NULL,
    "body_part" TEXT,
    "clinical_notes" TEXT,

    CONSTRAINT "imaging_order_detail_pkey" PRIMARY KEY ("clinical_order_id")
);

-- CreateTable
CREATE TABLE "procedure_order_detail" (
    "clinical_order_id" TEXT NOT NULL,
    "procedure_name" TEXT NOT NULL,
    "notes" TEXT,

    CONSTRAINT "procedure_order_detail_pkey" PRIMARY KEY ("clinical_order_id")
);

-- CreateTable
CREATE TABLE "referral_order_detail" (
    "clinical_order_id" TEXT NOT NULL,
    "referral_scope" "ReferralScope" NOT NULL,
    "referred_to_provider_id" TEXT,
    "referred_to_external" TEXT,
    "reason" TEXT,
    "referral_status" "ReferralStatus" NOT NULL DEFAULT 'issued',

    CONSTRAINT "referral_order_detail_pkey" PRIMARY KEY ("clinical_order_id")
);

-- CreateTable
CREATE TABLE "prescription" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "encounter_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "prescription_number" TEXT NOT NULL,
    "status" "PrescriptionStatus" NOT NULL DEFAULT 'active',
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "prescription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prescription_item" (
    "id" TEXT NOT NULL,
    "prescription_id" TEXT NOT NULL,
    "medication_name" TEXT NOT NULL,
    "generic_name" TEXT,
    "strength" TEXT,
    "dose" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "duration_days" INTEGER,
    "quantity" INTEGER,
    "instructions" TEXT,

    CONSTRAINT "prescription_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "follow_up_recommendation" (
    "id" TEXT NOT NULL,
    "encounter_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "recommended_date" DATE NOT NULL,
    "reason" TEXT,
    "status" "FollowUpStatus" NOT NULL DEFAULT 'open',
    "appointment_id" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follow_up_recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "episode_patient_id_idx" ON "episode"("patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "episode_organization_id_episode_number_key" ON "episode"("organization_id", "episode_number");

-- CreateIndex
CREATE UNIQUE INDEX "encounter_appointment_id_key" ON "encounter"("appointment_id");

-- CreateIndex
CREATE INDEX "encounter_patient_id_idx" ON "encounter"("patient_id");

-- CreateIndex
CREATE INDEX "encounter_provider_id_start_at_idx" ON "encounter"("provider_id", "start_at");

-- CreateIndex
CREATE UNIQUE INDEX "encounter_organization_id_encounter_number_key" ON "encounter"("organization_id", "encounter_number");

-- CreateIndex
CREATE INDEX "vital_sign_patient_id_recorded_at_idx" ON "vital_sign"("patient_id", "recorded_at");

-- CreateIndex
CREATE INDEX "vital_sign_encounter_id_idx" ON "vital_sign"("encounter_id");

-- CreateIndex
CREATE INDEX "diagnosis_patient_id_idx" ON "diagnosis"("patient_id");

-- CreateIndex
CREATE INDEX "diagnosis_encounter_id_idx" ON "diagnosis"("encounter_id");

-- CreateIndex
CREATE INDEX "clinical_note_encounter_id_note_type_is_current_idx" ON "clinical_note"("encounter_id", "note_type", "is_current");

-- CreateIndex
CREATE INDEX "clinical_note_patient_id_idx" ON "clinical_note"("patient_id");

-- CreateIndex
CREATE INDEX "clinical_order_patient_id_idx" ON "clinical_order"("patient_id");

-- CreateIndex
CREATE INDEX "clinical_order_encounter_id_idx" ON "clinical_order"("encounter_id");

-- CreateIndex
CREATE UNIQUE INDEX "clinical_order_organization_id_order_number_key" ON "clinical_order"("organization_id", "order_number");

-- CreateIndex
CREATE INDEX "prescription_patient_id_idx" ON "prescription"("patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "prescription_organization_id_prescription_number_key" ON "prescription"("organization_id", "prescription_number");

-- CreateIndex
CREATE INDEX "follow_up_recommendation_patient_id_status_idx" ON "follow_up_recommendation"("patient_id", "status");

-- AddForeignKey
ALTER TABLE "episode" ADD CONSTRAINT "episode_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "episode" ADD CONSTRAINT "episode_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "episode" ADD CONSTRAINT "episode_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "episode" ADD CONSTRAINT "episode_primary_provider_id_fkey" FOREIGN KEY ("primary_provider_id") REFERENCES "provider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "episode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vital_sign" ADD CONSTRAINT "vital_sign_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vital_sign" ADD CONSTRAINT "vital_sign_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vital_sign" ADD CONSTRAINT "vital_sign_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnosis" ADD CONSTRAINT "diagnosis_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnosis" ADD CONSTRAINT "diagnosis_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnosis" ADD CONSTRAINT "diagnosis_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "episode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnosis" ADD CONSTRAINT "diagnosis_diagnosis_code_fkey" FOREIGN KEY ("diagnosis_code") REFERENCES "diagnosis_code"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_amends_id_fkey" FOREIGN KEY ("amends_id") REFERENCES "clinical_note"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_ordering_provider_id_fkey" FOREIGN KEY ("ordering_provider_id") REFERENCES "provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_order_detail" ADD CONSTRAINT "lab_order_detail_clinical_order_id_fkey" FOREIGN KEY ("clinical_order_id") REFERENCES "clinical_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imaging_order_detail" ADD CONSTRAINT "imaging_order_detail_clinical_order_id_fkey" FOREIGN KEY ("clinical_order_id") REFERENCES "clinical_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procedure_order_detail" ADD CONSTRAINT "procedure_order_detail_clinical_order_id_fkey" FOREIGN KEY ("clinical_order_id") REFERENCES "clinical_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_order_detail" ADD CONSTRAINT "referral_order_detail_clinical_order_id_fkey" FOREIGN KEY ("clinical_order_id") REFERENCES "clinical_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_order_detail" ADD CONSTRAINT "referral_order_detail_referred_to_provider_id_fkey" FOREIGN KEY ("referred_to_provider_id") REFERENCES "provider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription_item" ADD CONSTRAINT "prescription_item_prescription_id_fkey" FOREIGN KEY ("prescription_id") REFERENCES "prescription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up_recommendation" ADD CONSTRAINT "follow_up_recommendation_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up_recommendation" ADD CONSTRAINT "follow_up_recommendation_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up_recommendation" ADD CONSTRAINT "follow_up_recommendation_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

