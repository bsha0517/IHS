
-- CreateEnum
CREATE TYPE "ImagingOrderStatus" AS ENUM ('ordered', 'scheduled', 'performed', 'reported', 'verified', 'cancelled');

-- CreateTable
CREATE TABLE "imaging_service" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "body_part" TEXT,
    "price" DECIMAL(14,2) NOT NULL,
    "turnaround_hours" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "imaging_service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "imaging_order" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "clinical_order_id" TEXT NOT NULL,
    "imaging_service_id" TEXT NOT NULL,
    "accession_number" TEXT NOT NULL,
    "status" "ImagingOrderStatus" NOT NULL DEFAULT 'ordered',
    "charge_id" TEXT,
    "room_id" TEXT,
    "scheduled_at" TIMESTAMPTZ(3),
    "performed_by" TEXT,
    "performed_at" TIMESTAMPTZ(3),
    "report_text" TEXT,
    "impression" TEXT,
    "reported_by" TEXT,
    "reported_at" TIMESTAMPTZ(3),
    "verified_by" TEXT,
    "verified_at" TIMESTAMPTZ(3),
    "external_image_url" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "imaging_order_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "imaging_service_organization_id_category_idx" ON "imaging_service"("organization_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "imaging_service_organization_id_code_key" ON "imaging_service"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "imaging_order_clinical_order_id_key" ON "imaging_order"("clinical_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "imaging_order_charge_id_key" ON "imaging_order"("charge_id");

-- CreateIndex
CREATE INDEX "imaging_order_organization_id_status_idx" ON "imaging_order"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "imaging_order_organization_id_accession_number_key" ON "imaging_order"("organization_id", "accession_number");

-- AddForeignKey
ALTER TABLE "imaging_service" ADD CONSTRAINT "imaging_service_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imaging_order" ADD CONSTRAINT "imaging_order_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imaging_order" ADD CONSTRAINT "imaging_order_clinical_order_id_fkey" FOREIGN KEY ("clinical_order_id") REFERENCES "clinical_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imaging_order" ADD CONSTRAINT "imaging_order_imaging_service_id_fkey" FOREIGN KEY ("imaging_service_id") REFERENCES "imaging_service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imaging_order" ADD CONSTRAINT "imaging_order_charge_id_fkey" FOREIGN KEY ("charge_id") REFERENCES "charge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imaging_order" ADD CONSTRAINT "imaging_order_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

