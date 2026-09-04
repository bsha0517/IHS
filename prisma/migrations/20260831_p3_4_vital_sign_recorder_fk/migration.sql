-- P3.4 §3: closes the P3.3 vitals-attribution backlog item — VitalSign.recordedBy
-- had no relation to User at all, unlike every other actor field in this schema.
-- Adds the FK on the *existing* recorded_by column (no new column, no backfill:
-- verified directly against every environment that recorded_by is set in exactly
-- one place, always to a real session.user.id, with zero existing nulls/orphans).
-- AddForeignKey
ALTER TABLE "vital_sign" ADD CONSTRAINT "vital_sign_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
