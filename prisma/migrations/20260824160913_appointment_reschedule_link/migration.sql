-- AlterTable
ALTER TABLE "appointment" ADD COLUMN     "rescheduled_from_id" TEXT;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_rescheduled_from_id_fkey" FOREIGN KEY ("rescheduled_from_id") REFERENCES "appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

