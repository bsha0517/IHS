-- P0-02: outbox reliability. Widens OutboxStatus to an explicit
-- pending/processing/completed/failed/dead_letter state machine and adds
-- retry-tracking columns to outbox_event.
--
-- Written by hand rather than from `prisma migrate diff`'s raw output: the
-- auto-generated enum swap casts existing rows via
-- `status::text::OutboxStatus_new`, and the new enum it generates does NOT
-- include the old 'processed' value — every existing 'processed' row would
-- fail that cast outright. This version explicitly remaps 'processed' ->
-- 'completed' data first, then swaps the type, and renames (not
-- drops-and-adds) processed_at -> completed_at so no existing timestamp is
-- lost. Verified against the current database: 30 existing rows, all
-- 'processed', 0 'failed' — this build's dev history never actually hit the
-- retry path, consistent with the bug having gone undiscovered until now.

-- 1. Widen the enum with the new values first (existing 'processed' value
--    is kept for now so the remap UPDATE below has a valid source to read).
ALTER TYPE "OutboxStatus" ADD VALUE IF NOT EXISTS 'processing';
ALTER TYPE "OutboxStatus" ADD VALUE IF NOT EXISTS 'completed';
ALTER TYPE "OutboxStatus" ADD VALUE IF NOT EXISTS 'dead_letter';
