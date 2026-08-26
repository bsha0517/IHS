import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import type { SessionContext } from "@/lib/auth/session"

/**
 * Generic org-scoped key/value settings (`setting` table, reserved since
 * Phase 1, never actually consumed by any domain until now). First real use:
 * the pharmacy module-disable toggle spec.md §29 explicitly requires
 * ("architecture must allow pharmacy to be disabled for clinics that do not
 * operate one"). branchId is always null here — no per-branch override has
 * named a need yet; add one only when a real settings key requires it.
 */
export async function getSetting<T>(organizationId: string, key: string, defaultValue: T): Promise<T> {
  const row = await db.setting.findFirst({ where: { organizationId, branchId: null, key } })
  return row ? (row.value as T) : defaultValue
}

export async function setSetting(session: SessionContext, key: string, value: unknown): Promise<void> {
  assertCan(session, "settings.edit")
  const existing = await db.setting.findFirst({
    where: { organizationId: session.user.organizationId, branchId: null, key },
  })
  if (existing) {
    await db.setting.update({ where: { id: existing.id }, data: { value: value as never } })
  } else {
    await db.setting.create({
      data: { organizationId: session.user.organizationId, branchId: null, key, value: value as never },
    })
  }
  await auditFromSession(session, existing ? "update" : "create", "setting", key, { new: { key, value } })
}

export const PHARMACY_ENABLED_KEY = "pharmacy_enabled"

export async function isPharmacyEnabled(organizationId: string): Promise<boolean> {
  return getSetting(organizationId, PHARMACY_ENABLED_KEY, true)
}

/**
 * "Clinical information must only become patient-visible according to
 * configurable release rules" (spec.md §57). A single org-wide switch is a
 * deliberately simple v1 of "configurable" — defaults to OFF (the safe
 * choice: a fresh org's portal never surfaces clinical data until an admin
 * opts in), gating prescriptions/lab-results/imaging-results in the portal
 * as a whole rather than a per-result release workflow. See PROJECT_STATUS.md's
 * Phase 12 Known Issues for why a finer-grained release mechanism was not
 * built this phase.
 */
export const PORTAL_CLINICAL_RELEASE_KEY = "portal_clinical_release_enabled"

export async function isPortalClinicalReleaseEnabled(organizationId: string): Promise<boolean> {
  return getSetting(organizationId, PORTAL_CLINICAL_RELEASE_KEY, false)
}
