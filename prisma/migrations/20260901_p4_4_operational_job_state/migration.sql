-- P4.4 §19/§25/§32: a durable heartbeat table for infrastructure jobs
-- (Outbox sweep scheduler, logical backup) — see the model's own doc
-- comment in schema.prisma. Not organization-scoped; platform-wide
-- infrastructure state only, never patient/financial content.
--
-- Hand-trimmed from `prisma migrate diff`'s raw output — the live database
-- carries the same pre-existing, unrelated drift already noted in
-- prisma/migrations/20260901_p4_3_login_history_rate_limit_channel/migration.sql
-- (a leftover `OutboxStatus` enum value nothing writes anymore, and a
-- cosmetically-renamed `payroll_run` index) — neither is related to this
-- change, so neither is included here.

-- CreateTable
CREATE TABLE "operational_job_state" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "last_attempt_at" TIMESTAMPTZ(3),
    "last_success_at" TIMESTAMPTZ(3),
    "last_failure_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "metadata" JSONB,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "operational_job_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "operational_job_state_key_key" ON "operational_job_state"("key");
