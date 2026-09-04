-- P3.10 §34/§35: prevent two payroll runs for the same organization/branch/
-- period from ever both existing — PayrollRunLine's own
-- @@unique([payroll_run_id, employee_id]) only prevented one employee
-- appearing twice WITHIN a single run; nothing previously stopped two HR
-- users (or one double-submitting) from creating two separate runs for the
-- same branch+period, each independently approvable/payable — a real
-- double-pay risk. Verified no existing duplicate (organization_id,
-- branch_id, period_start, period_end) rows exist in his_dev or his_test
-- before writing this migration.
CREATE UNIQUE INDEX "payroll_run_organization_id_branch_id_period_start_period__key" ON "payroll_run"("organization_id", "branch_id", "period_start", "period_end");
