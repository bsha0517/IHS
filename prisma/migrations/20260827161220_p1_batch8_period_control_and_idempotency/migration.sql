-- P1 Batch 8, §31: basic financial period control — see accounting/periods.ts.
-- A row exists here only for a calendar month that has actually been
-- closed; nothing is pre-created for future months.
CREATE TYPE "AccountingPeriodStatus" AS ENUM ('open', 'closed');

CREATE TABLE "accounting_period" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "period_start" TIMESTAMPTZ(3) NOT NULL,
    "period_end" TIMESTAMPTZ(3) NOT NULL,
    "status" "AccountingPeriodStatus" NOT NULL DEFAULT 'closed',
    "closed_by" TEXT,
    "closed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,

    CONSTRAINT "accounting_period_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "accounting_period_organization_id_period_start_key" ON "accounting_period"("organization_id", "period_start");

ALTER TABLE "accounting_period" ADD CONSTRAINT "accounting_period_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- P1 Batch 8, §33: business-level idempotency for "create a new record"
-- actions with nothing pre-existing to claim — see platform/idempotency.ts.
CREATE TABLE "idempotency_key" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "result_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "idempotency_key_organization_id_scope_key_key" ON "idempotency_key"("organization_id", "scope", "key");

ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
