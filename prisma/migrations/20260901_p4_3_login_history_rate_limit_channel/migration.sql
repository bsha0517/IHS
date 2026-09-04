-- P4.3 §9: adds a channel discriminator to login_history (staff vs. portal
-- — the portal previously had no login-history table of its own, per
-- PROJECT_STATUS.md's Phase 12 Known Issues) and an index supporting the
-- new IP-based brute-force throttle (src/lib/auth/rate-limit.ts), which
-- counts recent failed attempts by ip+channel within a sliding window.
--
-- Hand-reviewed and trimmed from `prisma migrate diff`'s raw output — the
-- live database was also carrying unrelated pre-existing drift (a leftover
-- `OutboxStatus` enum value ("processed") nothing writes anymore, and a
-- cosmetically-renamed index on payroll_run) that the raw diff would have
-- folded into this migration. Neither is a security issue and neither is
-- related to this change, so neither is included here — see this
-- migration's own scope in P4_3_PRODUCTION_SECURITY_HARDENING_REPORT.md.

-- CreateEnum
CREATE TYPE "LoginChannel" AS ENUM ('staff', 'portal');

-- AlterTable
ALTER TABLE "login_history" ADD COLUMN "channel" "LoginChannel" NOT NULL DEFAULT 'staff';

-- CreateIndex
CREATE INDEX "login_history_ip_channel_created_at_idx" ON "login_history"("ip", "channel", "created_at");
