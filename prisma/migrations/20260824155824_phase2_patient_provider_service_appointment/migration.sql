-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- CreateEnum
CREATE TYPE "SequenceResetPeriod" AS ENUM ('never', 'daily');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('male', 'female', 'other', 'unknown');

-- CreateEnum
CREATE TYPE "PatientStatus" AS ENUM ('active', 'inactive', 'deceased');

-- CreateEnum
CREATE TYPE "AllergySeverity" AS ENUM ('mild', 'moderate', 'severe');

-- CreateEnum
CREATE TYPE "PatientConditionCategory" AS ENUM ('chronic', 'active', 'previous', 'surgical_history', 'family_history', 'medical_history');

-- CreateEnum
CREATE TYPE "ProviderType" AS ENUM ('doctor', 'dentist', 'physiotherapist', 'nurse', 'therapist', 'other');

-- CreateEnum
CREATE TYPE "ProviderStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('scheduled', 'confirmed', 'arrived', 'checked_in', 'waiting', 'in_consultation', 'completed', 'cancelled', 'rescheduled', 'no_show');

-- CreateEnum
CREATE TYPE "BookingSource" AS ENUM ('walk_in', 'phone', 'online', 'staff');

-- AlterTable
ALTER TABLE "number_sequence" ADD COLUMN     "last_reset_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "reset_period" "SequenceResetPeriod" NOT NULL DEFAULT 'never';

-- CreateTable
CREATE TABLE "patient" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "registration_branch_id" TEXT NOT NULL,
    "mrn" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "middle_name" TEXT,
    "last_name" TEXT NOT NULL,
    "profile_photo_url" TEXT,
    "dob" DATE NOT NULL,
    "gender" "Gender" NOT NULL,
    "nationality" TEXT,
    "mobile" TEXT NOT NULL,
    "whatsapp" TEXT,
    "email" TEXT,
    "address_line" TEXT,
    "city" TEXT,
    "country" TEXT,
    "national_id" TEXT,
    "passport_number" TEXT,
    "emergency_contact_name" TEXT,
    "emergency_contact_relationship" TEXT,
    "emergency_contact_phone" TEXT,
    "preferred_language" TEXT,
    "referral_source" TEXT,
    "preferred_provider_id" TEXT,
    "status" "PatientStatus" NOT NULL DEFAULT 'active',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "patient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_allergy" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "allergen" TEXT NOT NULL,
    "reaction" TEXT,
    "severity" "AllergySeverity" NOT NULL,
    "is_alert" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "noted_by" TEXT,
    "noted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_allergy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_condition" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "category" "PatientConditionCategory" NOT NULL,
    "description" TEXT NOT NULL,
    "is_alert" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "noted_by" TEXT,
    "noted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_condition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_medication_history" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "medication_name" TEXT NOT NULL,
    "dose" TEXT,
    "status" TEXT NOT NULL DEFAULT 'current',
    "start_date" DATE,
    "end_date" DATE,
    "noted_by" TEXT,
    "noted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_medication_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "employee_id" TEXT,
    "provider_type" "ProviderType" NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "specialty" TEXT,
    "qualification" TEXT,
    "license_number" TEXT,
    "license_authority" TEXT,
    "license_issue_date" DATE,
    "license_expiry_date" DATE,
    "consultation_fee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "default_appointment_duration_minutes" INTEGER NOT NULL DEFAULT 30,
    "status" "ProviderStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_branch" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,

    CONSTRAINT "provider_branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_department" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,

    CONSTRAINT "provider_department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_schedule" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "department_id" TEXT,
    "room_id" TEXT,
    "day_of_week" INTEGER NOT NULL,
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,
    "slot_duration_minutes" INTEGER NOT NULL DEFAULT 30,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "provider_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_leave_block" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_leave_block_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "department_id" TEXT,
    "description" TEXT,
    "duration_minutes" INTEGER NOT NULL,
    "price" DECIMAL(14,2) NOT NULL,
    "billable" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "required_room_type" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_provider" (
    "id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,

    CONSTRAINT "service_provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "appointment_number" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "service_id" TEXT,
    "department_id" TEXT,
    "room_id" TEXT,
    "start_time" TIMESTAMP(3) NOT NULL,
    "end_time" TIMESTAMP(3) NOT NULL,
    "booking_source" "BookingSource" NOT NULL DEFAULT 'staff',
    "notes" TEXT,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'scheduled',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_status_history" (
    "id" TEXT NOT NULL,
    "appointment_id" TEXT NOT NULL,
    "from_status" "AppointmentStatus",
    "to_status" "AppointmentStatus" NOT NULL,
    "changed_by" TEXT,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,

    CONSTRAINT "appointment_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queue_entry" (
    "id" TEXT NOT NULL,
    "appointment_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "token_number" TEXT NOT NULL,
    "arrived_at" TIMESTAMP(3),
    "checked_in_at" TIMESTAMP(3),
    "called_at" TIMESTAMP(3),
    "consultation_start_at" TIMESTAMP(3),
    "consultation_end_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "queue_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "patient_organization_id_last_name_first_name_idx" ON "patient"("organization_id", "last_name", "first_name");

-- CreateIndex
CREATE INDEX "patient_organization_id_mobile_idx" ON "patient"("organization_id", "mobile");

-- CreateIndex
CREATE INDEX "patient_organization_id_email_idx" ON "patient"("organization_id", "email");

-- CreateIndex
CREATE INDEX "patient_organization_id_national_id_idx" ON "patient"("organization_id", "national_id");

-- CreateIndex
CREATE UNIQUE INDEX "patient_organization_id_mrn_key" ON "patient"("organization_id", "mrn");

-- CreateIndex
CREATE INDEX "patient_allergy_patient_id_idx" ON "patient_allergy"("patient_id");

-- CreateIndex
CREATE INDEX "patient_condition_patient_id_category_idx" ON "patient_condition"("patient_id", "category");

-- CreateIndex
CREATE INDEX "patient_medication_history_patient_id_idx" ON "patient_medication_history"("patient_id");

-- CreateIndex
CREATE INDEX "provider_organization_id_idx" ON "provider"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_branch_provider_id_branch_id_key" ON "provider_branch"("provider_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_department_provider_id_department_id_key" ON "provider_department"("provider_id", "department_id");

-- CreateIndex
CREATE INDEX "provider_schedule_provider_id_day_of_week_idx" ON "provider_schedule"("provider_id", "day_of_week");

-- CreateIndex
CREATE INDEX "provider_leave_block_provider_id_start_at_end_at_idx" ON "provider_leave_block"("provider_id", "start_at", "end_at");

-- CreateIndex
CREATE INDEX "service_organization_id_category_idx" ON "service"("organization_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "service_organization_id_code_key" ON "service"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "service_provider_service_id_provider_id_key" ON "service_provider"("service_id", "provider_id");

-- CreateIndex
CREATE INDEX "appointment_organization_id_branch_id_start_time_idx" ON "appointment"("organization_id", "branch_id", "start_time");

-- CreateIndex
CREATE INDEX "appointment_provider_id_start_time_idx" ON "appointment"("provider_id", "start_time");

-- CreateIndex
CREATE INDEX "appointment_patient_id_idx" ON "appointment"("patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_organization_id_appointment_number_key" ON "appointment"("organization_id", "appointment_number");

-- CreateIndex
CREATE INDEX "appointment_status_history_appointment_id_idx" ON "appointment_status_history"("appointment_id");

-- CreateIndex
CREATE UNIQUE INDEX "queue_entry_appointment_id_key" ON "queue_entry"("appointment_id");

-- CreateIndex
CREATE INDEX "queue_entry_branch_id_created_at_idx" ON "queue_entry"("branch_id", "created_at");

-- AddForeignKey
ALTER TABLE "clinical_access_log" ADD CONSTRAINT "clinical_access_log_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient" ADD CONSTRAINT "patient_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient" ADD CONSTRAINT "patient_registration_branch_id_fkey" FOREIGN KEY ("registration_branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient" ADD CONSTRAINT "patient_preferred_provider_id_fkey" FOREIGN KEY ("preferred_provider_id") REFERENCES "provider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_condition" ADD CONSTRAINT "patient_condition_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_medication_history" ADD CONSTRAINT "patient_medication_history_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider" ADD CONSTRAINT "provider_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_branch" ADD CONSTRAINT "provider_branch_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_branch" ADD CONSTRAINT "provider_branch_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_department" ADD CONSTRAINT "provider_department_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_department" ADD CONSTRAINT "provider_department_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_schedule" ADD CONSTRAINT "provider_schedule_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_schedule" ADD CONSTRAINT "provider_schedule_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_schedule" ADD CONSTRAINT "provider_schedule_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_schedule" ADD CONSTRAINT "provider_schedule_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_leave_block" ADD CONSTRAINT "provider_leave_block_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service" ADD CONSTRAINT "service_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service" ADD CONSTRAINT "service_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_provider" ADD CONSTRAINT "service_provider_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_provider" ADD CONSTRAINT "service_provider_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_status_history" ADD CONSTRAINT "appointment_status_history_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_entry" ADD CONSTRAINT "queue_entry_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_entry" ADD CONSTRAINT "queue_entry_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

