-- P0-05: cascade delete protection. Changes onDelete: Cascade to
-- onDelete: Restrict on 24 relations carrying clinical or financial
-- history that must not silently disappear if a parent record is ever
-- deleted (SYSTEM_AUDIT.md Critical #5) — Encounter's clinical children
-- (vitals, diagnoses, notes, orders and everything chained beneath orders,
-- prescriptions, follow-ups), Patient's safety-critical children
-- (allergies, conditions, medication history), and the financial ledger's
-- detail records (invoice lines, payment allocations, journal lines,
-- package sessions, payroll lines, claim items).
--
-- Non-destructive and safe against existing data: ON DELETE behavior only
-- governs what happens on a *future* delete of the parent row — it does
-- not validate or touch any existing row, and the underlying FK
-- relationship itself (which already required every existing child row to
-- reference a valid parent) is unchanged. No application code path deletes
-- any of these parent models today (verified via repo-wide grep during
-- P0_REMEDIATION_PLAN.md's design of this fix), so this migration has zero
-- behavioral effect on current operations — it only closes an unused
-- escape hatch.
--
-- Excludes this repo's `prisma migrate diff` re-emitting the P0-02 outbox
-- enum swap here too — that migration was already hand-applied with an
-- equivalent, data-preserving approach (see
-- 20260826192144_p0_02_outbox_reliability), and Prisma's diff tool simply
-- doesn't recognize the two as equivalent. Re-running that swap is now safe
-- (no row holds the old 'processed' value anymore) but adds nothing; kept
-- out to keep this migration scoped to cascade-delete protection only.

ALTER TABLE "patient_allergy" DROP CONSTRAINT "patient_allergy_patient_id_fkey";
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "patient_condition" DROP CONSTRAINT "patient_condition_patient_id_fkey";
ALTER TABLE "patient_condition" ADD CONSTRAINT "patient_condition_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "patient_medication_history" DROP CONSTRAINT "patient_medication_history_patient_id_fkey";
ALTER TABLE "patient_medication_history" ADD CONSTRAINT "patient_medication_history_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "vital_sign" DROP CONSTRAINT "vital_sign_encounter_id_fkey";
ALTER TABLE "vital_sign" ADD CONSTRAINT "vital_sign_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "diagnosis" DROP CONSTRAINT "diagnosis_encounter_id_fkey";
ALTER TABLE "diagnosis" ADD CONSTRAINT "diagnosis_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "clinical_note" DROP CONSTRAINT "clinical_note_encounter_id_fkey";
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "clinical_order" DROP CONSTRAINT "clinical_order_encounter_id_fkey";
ALTER TABLE "clinical_order" ADD CONSTRAINT "clinical_order_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "lab_order_detail" DROP CONSTRAINT "lab_order_detail_clinical_order_id_fkey";
ALTER TABLE "lab_order_detail" ADD CONSTRAINT "lab_order_detail_clinical_order_id_fkey" FOREIGN KEY ("clinical_order_id") REFERENCES "clinical_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "imaging_order_detail" DROP CONSTRAINT "imaging_order_detail_clinical_order_id_fkey";
ALTER TABLE "imaging_order_detail" ADD CONSTRAINT "imaging_order_detail_clinical_order_id_fkey" FOREIGN KEY ("clinical_order_id") REFERENCES "clinical_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "procedure_order_detail" DROP CONSTRAINT "procedure_order_detail_clinical_order_id_fkey";
ALTER TABLE "procedure_order_detail" ADD CONSTRAINT "procedure_order_detail_clinical_order_id_fkey" FOREIGN KEY ("clinical_order_id") REFERENCES "clinical_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "referral_order_detail" DROP CONSTRAINT "referral_order_detail_clinical_order_id_fkey";
ALTER TABLE "referral_order_detail" ADD CONSTRAINT "referral_order_detail_clinical_order_id_fkey" FOREIGN KEY ("clinical_order_id") REFERENCES "clinical_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "prescription" DROP CONSTRAINT "prescription_encounter_id_fkey";
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "prescription_item" DROP CONSTRAINT "prescription_item_prescription_id_fkey";
ALTER TABLE "prescription_item" ADD CONSTRAINT "prescription_item_prescription_id_fkey" FOREIGN KEY ("prescription_id") REFERENCES "prescription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "follow_up_recommendation" DROP CONSTRAINT "follow_up_recommendation_encounter_id_fkey";
ALTER TABLE "follow_up_recommendation" ADD CONSTRAINT "follow_up_recommendation_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invoice_line" DROP CONSTRAINT "invoice_line_invoice_id_fkey";
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_allocation" DROP CONSTRAINT "payment_allocation_payment_id_fkey";
ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "patient_package_session" DROP CONSTRAINT "patient_package_session_patient_package_id_fkey";
ALTER TABLE "patient_package_session" ADD CONSTRAINT "patient_package_session_patient_package_id_fkey" FOREIGN KEY ("patient_package_id") REFERENCES "patient_package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "journal_line" DROP CONSTRAINT "journal_line_journal_id_fkey";
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_journal_id_fkey" FOREIGN KEY ("journal_id") REFERENCES "journal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payroll_run_line" DROP CONSTRAINT "payroll_run_line_payroll_run_id_fkey";
ALTER TABLE "payroll_run_line" ADD CONSTRAINT "payroll_run_line_payroll_run_id_fkey" FOREIGN KEY ("payroll_run_id") REFERENCES "payroll_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "specimen" DROP CONSTRAINT "specimen_clinical_order_id_fkey";
ALTER TABLE "specimen" ADD CONSTRAINT "specimen_clinical_order_id_fkey" FOREIGN KEY ("clinical_order_id") REFERENCES "clinical_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "lab_order_test" DROP CONSTRAINT "lab_order_test_clinical_order_id_fkey";
ALTER TABLE "lab_order_test" ADD CONSTRAINT "lab_order_test_clinical_order_id_fkey" FOREIGN KEY ("clinical_order_id") REFERENCES "clinical_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dispensing_return" DROP CONSTRAINT "dispensing_return_dispensing_record_id_fkey";
ALTER TABLE "dispensing_return" ADD CONSTRAINT "dispensing_return_dispensing_record_id_fkey" FOREIGN KEY ("dispensing_record_id") REFERENCES "dispensing_record"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "imaging_order" DROP CONSTRAINT "imaging_order_clinical_order_id_fkey";
ALTER TABLE "imaging_order" ADD CONSTRAINT "imaging_order_clinical_order_id_fkey" FOREIGN KEY ("clinical_order_id") REFERENCES "clinical_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "claim_item" DROP CONSTRAINT "claim_item_claim_id_fkey";
ALTER TABLE "claim_item" ADD CONSTRAINT "claim_item_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
