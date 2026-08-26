
-- DropForeignKey
ALTER TABLE "payroll_run" DROP CONSTRAINT "payroll_run_branch_id_fkey";

-- AlterTable
ALTER TABLE "payroll_run" ALTER COLUMN "branch_id" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "payroll_run" ADD CONSTRAINT "payroll_run_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

