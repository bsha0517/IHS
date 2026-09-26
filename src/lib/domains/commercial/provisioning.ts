import "server-only"
import { db } from "@/lib/db"
import { Prisma } from "@/generated/prisma/client"
import { hashPassword } from "@/lib/auth/password"
import { generateRawToken, hashToken } from "@/lib/auth/tokens"
import { bootstrapSystemRoles } from "@/lib/domains/identity/system-roles"
import { seedModuleEntitlementsFromPlan } from "@/lib/platform/entitlements"
import { ensureOnboardingChecklist } from "@/lib/domains/commercial/onboarding-checklist"
import { ensureCommunicationTemplates } from "@/lib/domains/communications/templates"
import { writeAuditLog } from "@/lib/platform/audit"
import {
  claimPlatformIdempotencyKey,
  recordPlatformIdempotentResult,
  resolveDuplicatePlatformRequest,
  isPlatformIdempotencyKeyConflict,
} from "@/lib/platform/idempotency-platform"
import type { PlatformSessionContext } from "@/lib/auth/platform-session"
import type { ProvisionClinicInput } from "@/lib/domains/commercial/schemas"

const GO_LIVE_CONDITION_CODES = ["backup_restore_rehearsal", "error_monitoring", "clinic_uat_signoff", "transactional_email"] as const

// P5.1 §61: human-readable, support-facing, never secret, never derived
// from patient information. A simple count+1 (retried on the rare
// concurrent-collision case below) is sufficient for an operator-driven,
// low-frequency action — no dedicated global sequence table is introduced
// for this alone.
async function nextCustomerCode(tx: Prisma.TransactionClient): Promise<string> {
  const existingCount = await tx.organizationCommercialProfile.count()
  return `AVT-${String(existingCount + 1).padStart(6, "0")}`
}

export type ProvisionClinicResult = {
  organizationId: string
  branchId: string
  adminUserId: string
  commercialProfileId: string
  subscriptionId: string
  customerCode: string
  /** Raw, one-time activation token — never persisted in plain form (only its hash is). Show it to the operator exactly once; it cannot be recovered afterward. */
  activationToken: string
}

/**
 * P5.1 §24/§25/§26/§60: the one deliberate provisioning workflow — creates
 * Organization → Branch → system roles → initial admin → commercial profile
 * → subscription → go-live-condition checklist as a single atomic
 * transaction (so a mid-way failure can never leave an organization that
 * exists with no admin able to log into it), preceded by the one genuinely
 * CPU-heavy step (Argon2 hashing the admin's throwaway bootstrap secret —
 * §25's own named P4.9.2 lesson: never hold that inside a DB transaction).
 *
 * The initial admin never receives a client-chosen or generated password
 * directly (§26) — `passwordHash` is set to a hash of a random secret that
 * is immediately discarded (never returned, never logged), and a
 * `PasswordResetToken` is issued in the same transaction so the admin's
 * real password is set through the existing, already-audited
 * `/reset-password` flow. The raw activation token is returned ONCE to the
 * calling platform operator to relay to the clinic through a secure
 * channel of their choosing — the same "shown once, capture this now"
 * discipline `prisma/seed.ts` already uses for its own bootstrap password.
 */
export async function provisionClinic(operator: PlatformSessionContext, input: ProvisionClinicInput): Promise<ProvisionClinicResult> {
  const plan = await db.commercialPlan.findUniqueOrThrow({ where: { id: input.planId } })
  // P5.7 Part 5/26: an inactive plan is retained for historical subscriptions
  // (plans.ts never hard-deletes one) but must never be usable for a NEW
  // provisioning request — enforced here, server-side, not just by the
  // provisioning form omitting it from its dropdown.
  if (!plan.active) throw new Error("This plan is no longer active and cannot be used to provision a new organization.")

  const adminBootstrapSecret = generateRawToken()
  const adminPasswordHash = await hashPassword(adminBootstrapSecret)
  const activationRawToken = generateRawToken()
  const activationTokenHash = hashToken(activationRawToken)

  let result: ProvisionClinicResult
  try {
    result = await db.$transaction(async (tx) => {
      // Must be the very first statement — see claimPlatformIdempotencyKey's own doc comment.
      await claimPlatformIdempotencyKey(tx, { operatorId: operator.operator.id, scope: "provision_clinic", key: input.idempotencyKey })

      const organization = await tx.organization.create({
        data: {
          legalName: input.legalName,
          displayName: input.displayName,
          defaultCurrency: input.defaultCurrency,
          defaultTimezone: input.defaultTimezone,
        },
      })

      const branch = await tx.branch.create({
        data: {
          organizationId: organization.id,
          name: input.branchName,
          code: input.branchCode,
          timezone: input.defaultTimezone,
          address: input.branchAddress ?? null,
          phone: input.branchPhone ?? null,
        },
      })

      // §27: reuses the exact same role/permission catalog as the original
      // bootstrap organization — no duplicate "Clinic Owner" role invented.
      await bootstrapSystemRoles(tx, organization.id)
      const superAdminRole = await tx.role.findFirstOrThrow({ where: { organizationId: organization.id, name: "Super Admin" } })

      const adminUser = await tx.user.create({
        data: {
          organizationId: organization.id,
          email: input.adminEmail.trim().toLowerCase(),
          firstName: input.adminFirstName,
          lastName: input.adminLastName,
          passwordHash: adminPasswordHash,
        },
      })
      await tx.userRole.create({ data: { userId: adminUser.id, roleId: superAdminRole.id } })
      await tx.userBranchAccess.create({ data: { userId: adminUser.id, branchId: branch.id } })

      // A 7-day activation window — deliberately longer than the 30-minute
      // "forgot password" TTL (auth/service.ts) since this is a first-time
      // account handoff, not a live user recovering access.
      await tx.passwordResetToken.create({
        data: { userId: adminUser.id, tokenHash: activationTokenHash, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
      })

      const customerCode = await nextCustomerCode(tx)
      const commercialProfile = await tx.organizationCommercialProfile.create({
        data: {
          organizationId: organization.id,
          customerCode,
          legalBusinessName: input.legalBusinessName ?? null,
          primaryContactName: input.primaryContactName ?? null,
          primaryContactEmail: input.primaryContactEmail ?? null,
          primaryContactPhone: input.primaryContactPhone ?? null,
          billingContactName: input.billingContactName ?? null,
          billingContactEmail: input.billingContactEmail ?? null,
          country: input.country.toUpperCase(),
          implementationOwner: input.implementationOwner ?? null,
          internalNotes: input.internalNotes ?? null,
        },
      })

      const subscription = await tx.organizationSubscription.create({
        data: {
          organizationId: organization.id,
          commercialProfileId: commercialProfile.id,
          planId: plan.id,
          status: input.subscriptionStatus,
          startDate: input.startDate,
          trialEndsAt: input.trialEndsAt ?? null,
          agreedUserLimit: input.agreedUserLimit ?? plan.userLimit ?? null,
          agreedBranchLimit: input.agreedBranchLimit ?? plan.branchLimit ?? null,
          agreedAmount: input.agreedAmount ?? null,
          currency: input.currency ?? null,
          billingCycle: input.billingCycle ?? null,
          notes: input.subscriptionNotes ?? null,
        },
      })

      // §33/§34: seeded pending — an operator marks each complete with real
      // evidence later; never auto-completed by provisioning itself.
      for (const code of GO_LIVE_CONDITION_CODES) {
        await tx.goLiveCondition.create({ data: { commercialProfileId: commercialProfile.id, code } })
      }

      await recordPlatformIdempotentResult(tx, {
        operatorId: operator.operator.id,
        scope: "provision_clinic",
        key: input.idempotencyKey,
        resultId: organization.id,
      })

      return {
        organizationId: organization.id,
        branchId: branch.id,
        adminUserId: adminUser.id,
        commercialProfileId: commercialProfile.id,
        subscriptionId: subscription.id,
        customerCode,
        activationToken: activationRawToken,
      }
    }, { timeout: 20_000, maxWait: 10_000 }) // widened for the same reason posting-service.ts's POSTING_TRANSACTION_OPTIONS is — org/branch create, bootstrapSystemRoles' own per-role upsert loop, admin user + role/branch-access grants, activation token, customer-code count, commercial profile, subscription, and 4 go-live condition creates all add up under this environment's real Supabase pooler latency; a real production run caught this exact transaction exceeding Prisma's 5000ms default at ~5434ms (P5.6 release smoke test, P5.1.1 hotfix).
  } catch (e) {
    if (isPlatformIdempotencyKeyConflict(e)) {
      const resultId = await resolveDuplicatePlatformRequest({ operatorId: operator.operator.id, scope: "provision_clinic", key: input.idempotencyKey })
      throw new Error(`This clinic was already provisioned (organization ${resultId}) — this looks like a duplicate submission. Open it from the Organizations list; the one-time activation link is not re-shown.`)
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new Error("Provisioning failed — a record with one of these values (admin email, branch code, or customer code) already exists in the system. Please review and retry.")
    }
    throw e
  }

  // §29: module entitlements are seeded AFTER the core transaction commits
  // — additive Setting rows with no FK dependency beyond the now-committed
  // organizationId; if this step fails, the organization/branch/admin/
  // subscription remain fully valid and usable (every module simply stays
  // at its safe default of "enabled" until an operator re-runs entitlement
  // seeding from the organization detail page), never a half-created
  // tenant with no working administrator.
  const moduleKeysToEnable = input.moduleKeys ?? plan.defaultModuleKeys
  await seedModuleEntitlementsFromPlan({ organizationId: result.organizationId, defaultModuleKeys: moduleKeysToEnable, operatorId: operator.operator.id })

  // P5.2 §1/§2: seeds the onboarding checklist immediately so the operator
  // lands on a ready-to-use workspace right after provisioning — same
  // non-transactional, safe-to-retry reasoning as entitlement seeding just
  // above (ensureOnboardingChecklist is itself idempotent; a failure here
  // never leaves a half-created organization, only a checklist an operator
  // can re-sync from the onboarding workspace's own first load).
  await ensureOnboardingChecklist(result.organizationId, operator.operator.id)

  // P5.4 §3: same non-transactional, safe-to-retry, self-healing reasoning
  // as onboarding-checklist seeding just above — a fresh clinic's very
  // first appointment booking must be able to actually notify the patient,
  // not dead-letter forever for want of a template that was never seeded
  // (the real P5.3 UAT defect this closes).
  await ensureCommunicationTemplates(result.organizationId, operator.operator.id)

  await writeAuditLog({
    organizationId: result.organizationId,
    userId: operator.operator.id,
    action: "platform.organization.provisioned",
    entityType: "organization",
    entityId: result.organizationId,
    newValues: { displayName: input.displayName, customerCode: result.customerCode, planCode: plan.code },
  })

  return result
}
