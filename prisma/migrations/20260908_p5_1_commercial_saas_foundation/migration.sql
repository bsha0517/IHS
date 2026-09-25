-- CreateEnum
CREATE TYPE "PlatformOperatorStatus" AS ENUM ('active', 'suspended');

-- CreateEnum
CREATE TYPE "CommercialLifecycle" AS ENUM ('onboarding', 'live', 'closed');

-- CreateEnum
CREATE TYPE "CommercialOnboardingStatus" AS ENUM ('not_started', 'in_progress', 'ready_for_uat', 'uat', 'ready_for_go_live', 'live');

-- CreateEnum
CREATE TYPE "UatStatus" AS ENUM ('not_started', 'in_progress', 'passed', 'failed');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('trial', 'active', 'past_due', 'suspended', 'cancelled', 'expired');

-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('monthly', 'quarterly', 'annual', 'custom');

-- CreateEnum
CREATE TYPE "GoLiveConditionCode" AS ENUM ('backup_restore_rehearsal', 'error_monitoring', 'clinic_uat_signoff', 'transactional_email');

-- CreateEnum
CREATE TYPE "GoLiveConditionStatus" AS ENUM ('pending', 'complete', 'not_applicable');

-- AlterEnum
ALTER TYPE "LoginChannel" ADD VALUE 'platform';

-- CreateTable
CREATE TABLE "platform_operator" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "status" "PlatformOperatorStatus" NOT NULL DEFAULT 'active',
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_operator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_session" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_idempotency_key" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "result_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_idempotency_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_commercial_profile" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "customer_code" TEXT NOT NULL,
    "legal_business_name" TEXT,
    "primary_contact_name" TEXT,
    "primary_contact_email" TEXT,
    "primary_contact_phone" TEXT,
    "billing_contact_name" TEXT,
    "billing_contact_email" TEXT,
    "country" TEXT NOT NULL,
    "commercial_lifecycle" "CommercialLifecycle" NOT NULL DEFAULT 'onboarding',
    "onboarding_status" "CommercialOnboardingStatus" NOT NULL DEFAULT 'not_started',
    "uat_status" "UatStatus" NOT NULL DEFAULT 'not_started',
    "uat_note" TEXT,
    "implementation_owner" TEXT,
    "internal_notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organization_commercial_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commercial_plan" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "user_limit" INTEGER,
    "branch_limit" INTEGER,
    "default_module_keys" TEXT[],
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "commercial_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_subscription" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "commercial_profile_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'trial',
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "trial_ends_at" DATE,
    "agreed_user_limit" INTEGER,
    "agreed_branch_limit" INTEGER,
    "agreed_amount" DECIMAL(12,2),
    "currency" TEXT,
    "billing_cycle" "BillingCycle",
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organization_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "go_live_condition" (
    "id" TEXT NOT NULL,
    "commercial_profile_id" TEXT NOT NULL,
    "code" "GoLiveConditionCode" NOT NULL,
    "status" "GoLiveConditionStatus" NOT NULL DEFAULT 'pending',
    "completed_by_operator_id" TEXT,
    "completed_at" TIMESTAMPTZ(3),
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "go_live_condition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_operator_email_key" ON "platform_operator"("email");

-- CreateIndex
CREATE UNIQUE INDEX "platform_session_token_hash_key" ON "platform_session"("token_hash");

-- CreateIndex
CREATE INDEX "platform_session_operator_id_idx" ON "platform_session"("operator_id");

-- CreateIndex
CREATE INDEX "platform_session_expires_at_idx" ON "platform_session"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "platform_idempotency_key_operator_id_scope_key_key" ON "platform_idempotency_key"("operator_id", "scope", "key");

-- CreateIndex
CREATE UNIQUE INDEX "organization_commercial_profile_organization_id_key" ON "organization_commercial_profile"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_commercial_profile_customer_code_key" ON "organization_commercial_profile"("customer_code");

-- CreateIndex
CREATE UNIQUE INDEX "commercial_plan_code_key" ON "commercial_plan"("code");

-- CreateIndex
CREATE INDEX "organization_subscription_organization_id_created_at_idx" ON "organization_subscription"("organization_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "go_live_condition_commercial_profile_id_code_key" ON "go_live_condition"("commercial_profile_id", "code");

-- AddForeignKey
ALTER TABLE "platform_session" ADD CONSTRAINT "platform_session_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "platform_operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_idempotency_key" ADD CONSTRAINT "platform_idempotency_key_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "platform_operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_commercial_profile" ADD CONSTRAINT "organization_commercial_profile_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_subscription" ADD CONSTRAINT "organization_subscription_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_subscription" ADD CONSTRAINT "organization_subscription_commercial_profile_id_fkey" FOREIGN KEY ("commercial_profile_id") REFERENCES "organization_commercial_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_subscription" ADD CONSTRAINT "organization_subscription_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "commercial_plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "go_live_condition" ADD CONSTRAINT "go_live_condition_commercial_profile_id_fkey" FOREIGN KEY ("commercial_profile_id") REFERENCES "organization_commercial_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

