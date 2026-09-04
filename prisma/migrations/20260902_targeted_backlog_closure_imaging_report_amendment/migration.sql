-- Targeted commercial/safety backlog closure, item 7: a narrow amendment/
-- correction mechanism for finalized Radiology reports, analogous to Lab's
-- own isCurrent/amendsId chain on LabOrderTest — but as its own dedicated
-- table rather than a second ImagingOrder row, because ImagingOrder's
-- clinical_order_id is unique (exactly one row per ClinicalOrder), unlike
-- LabOrderTest which already supports many rows per order. See
-- ImagingReportAmendment's own doc comment in prisma/schema.prisma for the
-- full reasoning.
--
-- (Hand-trimmed: `prisma migrate diff` against the live dev database also
-- reported a pre-existing, unrelated `OutboxStatus` enum drift and a
-- cosmetic `payroll_run` index rename — both recurring noise from every
-- migration diff since P4.2, deliberately not included here.)

-- CreateTable
CREATE TABLE "imaging_report_amendment" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "imaging_order_id" TEXT NOT NULL,
    "report_text" TEXT,
    "impression" TEXT,
    "reason" TEXT NOT NULL,
    "amended_by" TEXT NOT NULL,
    "amended_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "imaging_report_amendment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "imaging_report_amendment_imaging_order_id_amended_at_idx" ON "imaging_report_amendment"("imaging_order_id", "amended_at");

-- AddForeignKey
ALTER TABLE "imaging_report_amendment" ADD CONSTRAINT "imaging_report_amendment_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imaging_report_amendment" ADD CONSTRAINT "imaging_report_amendment_imaging_order_id_fkey" FOREIGN KEY ("imaging_order_id") REFERENCES "imaging_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imaging_report_amendment" ADD CONSTRAINT "imaging_report_amendment_amended_by_fkey" FOREIGN KEY ("amended_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
