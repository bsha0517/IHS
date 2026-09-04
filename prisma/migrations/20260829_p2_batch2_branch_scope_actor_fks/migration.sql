-- P2 Batch 2 (§13, §14) — see P2_REMEDIATION_REPORT.md for the full record.
-- §13 (branch scoping) needed no schema change — the existing branch-
-- ownership model was already correct; the real findings there were two
-- read-path fixes in application code (prescriptions.ts, follow-ups.ts),
-- not migrated here. §14 (actor FKs) adds real relations to `user` for 34
-- Category A fields (see DATABASE.md's "P2 Remediation Schema Changes,
-- Batch 2" for the full field-by-field classification and reasoning) —
-- every existing non-null value was verified to reference a real user.id
-- before this migration was written; one real orphan pair was found and
-- fixed first (see that same section).

-- AlterTable: reconcile the two Batch-1 backfill defaults with the schema's
-- own @updatedAt-only declaration (no @default) — Batch 1's hand-corrected
-- migration intentionally added DEFAULT CURRENT_TIMESTAMP for the backfill;
-- this drops it now that every row has a real value and Prisma's own
-- @updatedAt mechanism (not a DB default) is what sets it on every future
-- write.
ALTER TABLE "charge" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "invoice" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "payment" ALTER COLUMN "updated_at" DROP DEFAULT;

-- §14 Category A: 34 real FK relations to "user", one per field classified
-- Category A this batch. onDelete: Restrict throughout — a historical
-- clinical/financial/security record must survive the actor's account
-- being deactivated (this app never hard-deletes a User today; Restrict
-- makes that a hard guarantee rather than an unenforced convention, the
-- same reasoning P0-05 already applied to every clinical/financial parent
-- relation).
ALTER TABLE "patient_allergy" ADD CONSTRAINT "patient_allergy_noted_by_fkey" FOREIGN KEY ("noted_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient_condition" ADD CONSTRAINT "patient_condition_noted_by_fkey" FOREIGN KEY ("noted_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient_medication_history" ADD CONSTRAINT "patient_medication_history_noted_by_fkey" FOREIGN KEY ("noted_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointment_status_history" ADD CONSTRAINT "appointment_status_history_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "episode" ADD CONSTRAINT "episode_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "diagnosis" ADD CONSTRAINT "diagnosis_diagnosed_by_fkey" FOREIGN KEY ("diagnosed_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_authored_by_fkey" FOREIGN KEY ("authored_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_finalized_by_fkey" FOREIGN KEY ("finalized_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "charge" ADD CONSTRAINT "charge_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment" ADD CONSTRAINT "payment_received_by_fkey" FOREIGN KEY ("received_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund" ADD CONSTRAINT "refund_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund" ADD CONSTRAINT "refund_authorized_by_fkey" FOREIGN KEY ("authorized_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_movement" ADD CONSTRAINT "cash_movement_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_request" ADD CONSTRAINT "purchase_request_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_request" ADD CONSTRAINT "purchase_request_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "goods_receipt" ADD CONSTRAINT "goods_receipt_received_by_fkey" FOREIGN KEY ("received_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_payment" ADD CONSTRAINT "supplier_payment_paid_by_fkey" FOREIGN KEY ("paid_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "accounting_period" ADD CONSTRAINT "accounting_period_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal" ADD CONSTRAINT "journal_posted_by_fkey" FOREIGN KEY ("posted_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expense" ADD CONSTRAINT "expense_paid_by_fkey" FOREIGN KEY ("paid_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leave_request" ADD CONSTRAINT "leave_request_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payroll_run" ADD CONSTRAINT "payroll_run_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payroll_run" ADD CONSTRAINT "payroll_run_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "specimen" ADD CONSTRAINT "specimen_collected_by_fkey" FOREIGN KEY ("collected_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lab_order_test" ADD CONSTRAINT "lab_order_test_entered_by_fkey" FOREIGN KEY ("entered_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lab_order_test" ADD CONSTRAINT "lab_order_test_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dispensing_record" ADD CONSTRAINT "dispensing_record_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dispensing_record" ADD CONSTRAINT "dispensing_record_dispensed_by_fkey" FOREIGN KEY ("dispensed_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dispensing_return" ADD CONSTRAINT "dispensing_return_returned_by_fkey" FOREIGN KEY ("returned_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "imaging_order" ADD CONSTRAINT "imaging_order_performed_by_fkey" FOREIGN KEY ("performed_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "imaging_order" ADD CONSTRAINT "imaging_order_reported_by_fkey" FOREIGN KEY ("reported_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "imaging_order" ADD CONSTRAINT "imaging_order_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
