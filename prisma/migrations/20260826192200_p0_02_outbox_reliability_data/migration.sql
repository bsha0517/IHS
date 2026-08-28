-- P0-02 (part 2): PostgreSQL requires a newly ALTER TYPE ... ADD VALUE'd
-- enum member to be committed in its own transaction before it can be used
-- — hence this is a separate migration file from the one that added
-- 'processing'/'completed'/'dead_letter' (Prisma applies each migration
-- file as its own transaction).

-- Remap existing data onto the new vocabulary before the old 'processed'
-- value becomes unreachable. All 30 existing rows in this database are
-- 'processed'; none are 'failed', so there is nothing to map for the old
-- failed state (it keeps its name).
UPDATE "outbox_event" SET "status" = 'completed' WHERE "status" = 'processed';

-- Preserve existing processedAt timestamps by renaming, not
-- dropping-and-recreating, the column.
ALTER TABLE "outbox_event" RENAME COLUMN "processed_at" TO "completed_at";

-- New retry-tracking columns. attempts defaults to 0 for new rows; existing
-- (now-'completed') rows are backfilled to 1 (they succeeded on their only
-- recorded attempt — there is no real attempt-count history to reconstruct
-- for them, and 1 is the accurate lower bound).
ALTER TABLE "outbox_event"
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_attempt_at" TIMESTAMPTZ(3),
  ADD COLUMN "next_retry_at" TIMESTAMPTZ(3),
  ADD COLUMN "last_error" TEXT;

UPDATE "outbox_event" SET "attempts" = 1, "last_attempt_at" = "completed_at" WHERE "status" = 'completed';

CREATE INDEX "outbox_event_status_next_retry_at_idx" ON "outbox_event"("status", "next_retry_at");

-- The old 'processed' enum value has no remaining rows and no application
-- code path that can produce it going forward, but PostgreSQL has no
-- `DROP VALUE` for enums short of the full type-recreation dance — left in
-- place as an inert, permanently-unused legacy value rather than taking on
-- that risk for a purely cosmetic cleanup.
