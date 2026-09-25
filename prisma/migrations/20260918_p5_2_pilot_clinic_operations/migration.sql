-- P5.2 — Pilot Clinic Operations & Productization. Purely additive: 5 new
-- enums, 1 new enum value (GoLiveConditionStatus.blocked), 3 new nullable
-- columns on organization_commercial_profile, 5 new tables. No drops, no
-- renames, no data migration.
--
-- Two unrelated statements `prisma migrate diff` also generated against the
-- live database were deliberately EXCLUDED from this file after
-- investigation (raw diff output kept in this migration's own history —
-- see the P5.2 completion report's Known Limitations / BACKLOG.md): (1) a
-- rebuild of the OutboxStatus enum to drop an unused legacy value
-- ("processed", superseded by "completed" in an earlier phase but never
-- dropped from the live enum type — Postgres does not support dropping an
-- enum value without a full type recreation), and (2) a cosmetic rename of
-- an auto-generated payroll_run index identifier
-- (...period__key -> ...period_e_key, a harmless Prisma-version
-- auto-truncation difference). Both are genuine, pre-existing, harmless
-- drift between the live database and a byte-for-byte replay of the
-- migration history — unrelated to P5.2, not a security/data-integrity/
-- destructive risk, and out of this phase's scope per its own "do not
-- reopen old phases unnecessarily" instruction. Logged in BACKLOG.md rather
-- than silently bundled into this feature migration.

-- CreateEnum
CREATE TYPE "OnboardingChecklistStatus" AS ENUM ('not_started', 'in_progress', 'blocked', 'completed', 'waived');

-- CreateEnum
CREATE TYPE "SupportTicketStatus" AS ENUM ('open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed');

-- CreateEnum
CREATE TYPE "SupportTicketPriority" AS ENUM ('low', 'normal', 'high', 'critical');

-- CreateEnum
CREATE TYPE "SupportTicketNoteVisibility" AS ENUM ('internal', 'customer');

-- CreateEnum
CREATE TYPE "PilotUatResultStatus" AS ENUM ('in_progress', 'passed', 'failed');

-- AlterEnum
ALTER TYPE "GoLiveConditionStatus" ADD VALUE 'blocked';

-- AlterTable
ALTER TABLE "organization_commercial_profile" ADD COLUMN     "go_live_approved_at" TIMESTAMPTZ(3),
ADD COLUMN     "go_live_approved_by_operator_id" TEXT,
ADD COLUMN     "go_live_notes" TEXT;

-- CreateTable
CREATE TABLE "onboarding_checklist_item" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "status" "OnboardingChecklistStatus" NOT NULL DEFAULT 'not_started',
    "owner_label" TEXT,
    "due_date" DATE,
    "notes" TEXT,
    "evidence_reference" TEXT,
    "completed_by_operator_id" TEXT,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "onboarding_checklist_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_ticket" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "ticket_number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "priority" "SupportTicketPriority" NOT NULL DEFAULT 'normal',
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'open',
    "assigned_operator_id" TEXT,
    "created_by_operator_id" TEXT,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "support_ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_ticket_note" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "visibility" "SupportTicketNoteVisibility" NOT NULL DEFAULT 'internal',
    "author_operator_id" TEXT,
    "author_user_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pilot_uat" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "cycle_label" TEXT NOT NULL,
    "tester_name" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "result" "PilotUatResultStatus" NOT NULL DEFAULT 'in_progress',
    "blockers" TEXT,
    "notes" TEXT,
    "signed_off_by_operator_id" TEXT,
    "signed_off_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pilot_uat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pilot_uat_scenario" (
    "id" TEXT NOT NULL,
    "uat_id" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "scenario" TEXT NOT NULL,
    "passed" BOOLEAN,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pilot_uat_scenario_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "onboarding_checklist_item_organization_id_category_idx" ON "onboarding_checklist_item"("organization_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_checklist_item_organization_id_key_key" ON "onboarding_checklist_item"("organization_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "support_ticket_ticket_number_key" ON "support_ticket"("ticket_number");

-- CreateIndex
CREATE INDEX "support_ticket_organization_id_status_idx" ON "support_ticket"("organization_id", "status");

-- CreateIndex
CREATE INDEX "support_ticket_assigned_operator_id_idx" ON "support_ticket"("assigned_operator_id");

-- CreateIndex
CREATE INDEX "support_ticket_note_ticket_id_idx" ON "support_ticket_note"("ticket_id");

-- CreateIndex
CREATE INDEX "support_ticket_note_organization_id_idx" ON "support_ticket_note"("organization_id");

-- CreateIndex
CREATE INDEX "pilot_uat_organization_id_created_at_idx" ON "pilot_uat"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "pilot_uat_scenario_uat_id_idx" ON "pilot_uat_scenario"("uat_id");

-- AddForeignKey
ALTER TABLE "onboarding_checklist_item" ADD CONSTRAINT "onboarding_checklist_item_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket" ADD CONSTRAINT "support_ticket_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket_note" ADD CONSTRAINT "support_ticket_note_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pilot_uat" ADD CONSTRAINT "pilot_uat_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pilot_uat_scenario" ADD CONSTRAINT "pilot_uat_scenario_uat_id_fkey" FOREIGN KEY ("uat_id") REFERENCES "pilot_uat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

