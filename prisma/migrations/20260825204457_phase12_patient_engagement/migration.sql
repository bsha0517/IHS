
-- CreateEnum
CREATE TYPE "CommChannel" AS ENUM ('sms', 'whatsapp', 'email');

-- CreateEnum
CREATE TYPE "CommMessageStatus" AS ENUM ('queued', 'sent', 'failed');

-- CreateEnum
CREATE TYPE "PortalAccountStatus" AS ENUM ('active', 'inactive', 'locked');

-- CreateTable
CREATE TABLE "comm_template" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "channel" "CommChannel" NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "comm_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comm_message" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "channel" "CommChannel" NOT NULL,
    "template_id" TEXT,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "recipient_address" TEXT NOT NULL,
    "status" "CommMessageStatus" NOT NULL DEFAULT 'queued',
    "provider_reference" TEXT,
    "error" TEXT,
    "reference_type" TEXT,
    "reference_id" TEXT,
    "sent_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comm_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_portal_account" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "status" "PortalAccountStatus" NOT NULL DEFAULT 'active',
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "patient_portal_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_portal_session" (
    "id" TEXT NOT NULL,
    "portal_account_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_portal_session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "comm_template_organization_id_key_key" ON "comm_template"("organization_id", "key");

-- CreateIndex
CREATE INDEX "comm_message_organization_id_patient_id_idx" ON "comm_message"("organization_id", "patient_id");

-- CreateIndex
CREATE INDEX "comm_message_organization_id_created_at_idx" ON "comm_message"("organization_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "patient_portal_account_patient_id_key" ON "patient_portal_account"("patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "patient_portal_account_organization_id_email_key" ON "patient_portal_account"("organization_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "patient_portal_session_token_hash_key" ON "patient_portal_session"("token_hash");

-- CreateIndex
CREATE INDEX "patient_portal_session_portal_account_id_idx" ON "patient_portal_session"("portal_account_id");

-- CreateIndex
CREATE INDEX "patient_portal_session_expires_at_idx" ON "patient_portal_session"("expires_at");

-- AddForeignKey
ALTER TABLE "comm_template" ADD CONSTRAINT "comm_template_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comm_message" ADD CONSTRAINT "comm_message_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comm_message" ADD CONSTRAINT "comm_message_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comm_message" ADD CONSTRAINT "comm_message_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "comm_template"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_portal_account" ADD CONSTRAINT "patient_portal_account_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_portal_account" ADD CONSTRAINT "patient_portal_account_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_portal_session" ADD CONSTRAINT "patient_portal_session_portal_account_id_fkey" FOREIGN KEY ("portal_account_id") REFERENCES "patient_portal_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

