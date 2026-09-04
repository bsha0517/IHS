-- Targeted commercial/safety backlog closure, item 8: records whether a
-- dispense against a medication that didn't obviously match the prescribed
-- one was an explicitly-confirmed substitution. See DispensingRecord's own
-- doc comment in prisma/schema.prisma.
--
-- (Hand-trimmed: `prisma migrate diff` also reported the same pre-existing,
-- unrelated OutboxStatus enum drift and payroll_run index rename noted in
-- every migration diff since P4.2 — deliberately not included here.)

-- AlterTable
ALTER TABLE "dispensing_record" ADD COLUMN     "substitution_confirmed" BOOLEAN NOT NULL DEFAULT false;
