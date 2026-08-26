-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');

-- CreateTable
CREATE TABLE "chart_of_account" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "parent_account_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chart_of_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_mapping" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "branch_id" TEXT,
    "intent" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "journal_number" TEXT NOT NULL,
    "journal_date" TIMESTAMPTZ(3) NOT NULL,
    "reference_type" TEXT NOT NULL,
    "reference_id" TEXT,
    "description" TEXT NOT NULL,
    "posted_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_line" (
    "id" TEXT NOT NULL,
    "journal_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "description" TEXT,

    CONSTRAINT "journal_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "expense_account_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "paid_via" "PaymentMethod" NOT NULL,
    "expense_date" DATE NOT NULL,
    "paid_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chart_of_account_organization_id_type_idx" ON "chart_of_account"("organization_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "chart_of_account_organization_id_code_key" ON "chart_of_account"("organization_id", "code");

-- CreateIndex
CREATE INDEX "account_mapping_organization_id_intent_branch_id_idx" ON "account_mapping"("organization_id", "intent", "branch_id");

-- CreateIndex
CREATE INDEX "journal_organization_id_reference_type_reference_id_idx" ON "journal"("organization_id", "reference_type", "reference_id");

-- CreateIndex
CREATE INDEX "journal_organization_id_journal_date_idx" ON "journal"("organization_id", "journal_date");

-- CreateIndex
CREATE UNIQUE INDEX "journal_organization_id_journal_number_key" ON "journal"("organization_id", "journal_number");

-- CreateIndex
CREATE INDEX "journal_line_journal_id_idx" ON "journal_line"("journal_id");

-- CreateIndex
CREATE INDEX "journal_line_account_id_idx" ON "journal_line"("account_id");

-- CreateIndex
CREATE INDEX "expense_organization_id_branch_id_expense_date_idx" ON "expense"("organization_id", "branch_id", "expense_date");

-- AddForeignKey
ALTER TABLE "chart_of_account" ADD CONSTRAINT "chart_of_account_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chart_of_account" ADD CONSTRAINT "chart_of_account_parent_account_id_fkey" FOREIGN KEY ("parent_account_id") REFERENCES "chart_of_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_mapping" ADD CONSTRAINT "account_mapping_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_mapping" ADD CONSTRAINT "account_mapping_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_mapping" ADD CONSTRAINT "account_mapping_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "chart_of_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal" ADD CONSTRAINT "journal_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal" ADD CONSTRAINT "journal_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_journal_id_fkey" FOREIGN KEY ("journal_id") REFERENCES "journal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "chart_of_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense" ADD CONSTRAINT "expense_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense" ADD CONSTRAINT "expense_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense" ADD CONSTRAINT "expense_expense_account_id_fkey" FOREIGN KEY ("expense_account_id") REFERENCES "chart_of_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written: Prisma's schema language cannot express a cross-row trigger,
-- so this is appended after `migrate diff` generates the table DDL above
-- (see DATABASE.md Conventions, which already named this exact requirement).
-- Enforces spec.md §54/§92: "Total Debit = Total Credit" per journal, and
-- "never create unbalanced journals". Deferred to end-of-transaction so a
-- journal's lines can be inserted one at a time (as the posting service
-- does) without failing mid-insert on a transiently-unbalanced state.
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_one_sided"
  CHECK (("debit" > 0 AND "credit" = 0) OR ("debit" = 0 AND "credit" > 0));

CREATE OR REPLACE FUNCTION check_journal_balance() RETURNS TRIGGER AS $$
DECLARE
  target_journal_id TEXT;
  total_debit NUMERIC(14,2);
  total_credit NUMERIC(14,2);
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_journal_id := OLD.journal_id;
  ELSE
    target_journal_id := NEW.journal_id;
  END IF;

  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
    INTO total_debit, total_credit
    FROM "journal_line"
    WHERE journal_id = target_journal_id;

  IF total_debit <> total_credit THEN
    RAISE EXCEPTION 'Journal % is unbalanced: total debit % does not equal total credit %', target_journal_id, total_debit, total_credit;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journal_line_balance_check
  AFTER INSERT OR UPDATE OR DELETE ON "journal_line"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION check_journal_balance();

