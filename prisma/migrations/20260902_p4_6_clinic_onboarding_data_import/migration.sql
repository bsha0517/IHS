-- P4.6 (Data Import / Clinic Onboarding / Initial Setup):
--   * Patient.legacy_mrn — cross-reference to a migrated patient's old
--     system identifier, preserved without ever overwriting Avant's own
--     system-generated MRN sequence.
--   * ImportJob / ImportJobError — the durable dry-run-then-commit import
--     job record and its row-level validation errors. Deliberately never
--     stores the uploaded file itself or full source row content — see
--     both models' own doc comments in prisma/schema.prisma.
--
-- (Hand-trimmed: `prisma migrate diff` also reported the same pre-existing,
-- unrelated OutboxStatus enum drift and payroll_run index rename noted in
-- every migration diff since P4.2 — deliberately not included here.)

-- CreateEnum
CREATE TYPE "ImportJobStatus" AS ENUM ('uploaded', 'validated', 'ready', 'processing', 'completed', 'failed', 'cancelled');

-- AlterTable
ALTER TABLE "patient" ADD COLUMN     "legacy_mrn" TEXT;

-- CreateTable
CREATE TABLE "import_job" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "branch_id" TEXT,
    "type" TEXT NOT NULL,
    "template_version" TEXT NOT NULL,
    "status" "ImportJobStatus" NOT NULL DEFAULT 'uploaded',
    "file_name" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "valid_rows" INTEGER NOT NULL DEFAULT 0,
    "invalid_rows" INTEGER NOT NULL DEFAULT 0,
    "duplicate_rows" INTEGER NOT NULL DEFAULT 0,
    "imported_rows" INTEGER NOT NULL DEFAULT 0,
    "skipped_rows" INTEGER NOT NULL DEFAULT 0,
    "summary" JSONB,
    "started_by" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "import_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_job_error" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "row_number" INTEGER NOT NULL,
    "field" TEXT,
    "error_code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_job_error_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_job_organization_id_type_started_at_idx" ON "import_job"("organization_id", "type", "started_at");

-- CreateIndex
CREATE INDEX "import_job_error_job_id_row_number_idx" ON "import_job_error"("job_id", "row_number");

-- CreateIndex
CREATE INDEX "patient_organization_id_legacy_mrn_idx" ON "patient"("organization_id", "legacy_mrn");

-- AddForeignKey
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_started_by_fkey" FOREIGN KEY ("started_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_job_error" ADD CONSTRAINT "import_job_error_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "import_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
