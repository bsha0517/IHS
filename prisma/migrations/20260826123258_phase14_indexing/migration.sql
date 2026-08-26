
-- CreateIndex
CREATE INDEX "appointment_service_id_idx" ON "appointment"("service_id");

-- CreateIndex
CREATE INDEX "charge_branch_id_idx" ON "charge"("branch_id");

-- CreateIndex
CREATE INDEX "charge_provider_id_idx" ON "charge"("provider_id");

-- CreateIndex
CREATE INDEX "charge_service_id_idx" ON "charge"("service_id");

-- CreateIndex
CREATE INDEX "claim_branch_id_idx" ON "claim"("branch_id");

-- CreateIndex
CREATE INDEX "claim_patient_id_idx" ON "claim"("patient_id");

-- CreateIndex
CREATE INDEX "claim_payor_id_idx" ON "claim"("payor_id");

-- CreateIndex
CREATE INDEX "clinical_order_branch_id_idx" ON "clinical_order"("branch_id");

-- CreateIndex
CREATE INDEX "clinical_order_ordering_provider_id_idx" ON "clinical_order"("ordering_provider_id");

-- CreateIndex
CREATE INDEX "commission_accrual_branch_id_idx" ON "commission_accrual"("branch_id");

-- CreateIndex
CREATE INDEX "commission_accrual_invoice_id_idx" ON "commission_accrual"("invoice_id");

-- CreateIndex
CREATE INDEX "dispensing_record_prescription_id_idx" ON "dispensing_record"("prescription_id");

-- CreateIndex
CREATE INDEX "dispensing_record_branch_id_idx" ON "dispensing_record"("branch_id");

-- CreateIndex
CREATE INDEX "dispensing_record_patient_id_idx" ON "dispensing_record"("patient_id");

-- CreateIndex
CREATE INDEX "dispensing_record_medication_id_idx" ON "dispensing_record"("medication_id");

-- CreateIndex
CREATE INDEX "encounter_branch_id_idx" ON "encounter"("branch_id");

-- CreateIndex
CREATE INDEX "encounter_episode_id_idx" ON "encounter"("episode_id");

-- CreateIndex
CREATE INDEX "follow_up_recommendation_encounter_id_idx" ON "follow_up_recommendation"("encounter_id");

-- CreateIndex
CREATE INDEX "imaging_order_imaging_service_id_idx" ON "imaging_order"("imaging_service_id");

-- CreateIndex
CREATE INDEX "invoice_branch_id_idx" ON "invoice"("branch_id");

-- CreateIndex
CREATE INDEX "invoice_provider_id_idx" ON "invoice"("provider_id");

-- CreateIndex
CREATE INDEX "invoice_payor_id_idx" ON "invoice"("payor_id");

-- CreateIndex
CREATE INDEX "journal_branch_id_idx" ON "journal"("branch_id");

-- CreateIndex
CREATE INDEX "lab_order_test_lab_test_id_idx" ON "lab_order_test"("lab_test_id");

-- CreateIndex
CREATE INDEX "lab_order_test_specimen_id_idx" ON "lab_order_test"("specimen_id");

-- CreateIndex
CREATE INDEX "patient_package_branch_id_idx" ON "patient_package"("branch_id");

-- CreateIndex
CREATE INDEX "patient_package_invoice_id_idx" ON "patient_package"("invoice_id");

-- CreateIndex
CREATE INDEX "payment_branch_id_idx" ON "payment"("branch_id");

-- CreateIndex
CREATE INDEX "payment_claim_id_idx" ON "payment"("claim_id");

-- CreateIndex
CREATE INDEX "prescription_encounter_id_idx" ON "prescription"("encounter_id");

-- CreateIndex
CREATE INDEX "prescription_provider_id_idx" ON "prescription"("provider_id");

-- CreateIndex
CREATE INDEX "refund_branch_id_idx" ON "refund"("branch_id");

-- CreateIndex
CREATE INDEX "refund_payment_id_idx" ON "refund"("payment_id");

-- CreateIndex
CREATE INDEX "vital_sign_branch_id_idx" ON "vital_sign"("branch_id");

