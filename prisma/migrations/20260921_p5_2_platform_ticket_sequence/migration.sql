-- P5.2 follow-up: a genuinely platform-wide (no organizationId) number
-- sequence table, added after this phase's own integration test caught a
-- real bug — SupportTicket.ticketNumber is globally unique, but was
-- initially generated via the org-scoped NumberSequence mechanism, so two
-- different organizations' first tickets both generated "SUP-000001" and
-- collided on the unique constraint. See PlatformNumberSequence's own
-- schema doc comment for the full reasoning.
--
-- The unrelated OutboxStatus enum rebuild and payroll_run index rename
-- `prisma migrate diff` also generated against the live database were
-- excluded again, for the same reason as the previous P5.2 migration's own
-- header comment (pre-existing, unrelated drift — see BACKLOG.md).

-- CreateTable
CREATE TABLE "platform_number_sequence" (
    "id" TEXT NOT NULL,
    "sequence_type" TEXT NOT NULL,
    "current_value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "platform_number_sequence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_number_sequence_sequence_type_key" ON "platform_number_sequence"("sequence_type");
