import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import type { SessionContext } from "@/lib/auth/session"

/**
 * Non-secret ZATCA seller configuration lives in the generic `Setting` table
 * (the existing org-scoped key/value store — see settings.ts), the same
 * precedent as pharmacy_enabled/portal_clinical_release_enabled. Secret
 * material (Compliance/Production CSID, Secret, private key) is NEVER stored
 * here or anywhere in the database — this codebase's own convention is that
 * every credential is a plain process.env.* read (grep DEPLOYMENT.md's
 * "Environment Variables" section), and a real X.509 private key is exactly
 * the kind of material that must not be persisted in application-readable
 * rows. See env.ts in this same directory for the env-var side.
 */
export const ZATCA_SELLER_PROFILE_KEY = "zatca.sellerProfile"

export type ZatcaSellerProfile = {
  enabled: boolean
  vatRegistrationNumber: string
  sellerName: string
  buildingNumber: string
  streetName: string
  district: string
  city: string
  postalCode: string
  additionalNumber: string
  countryCode: string
}

const DISABLED_PROFILE: ZatcaSellerProfile = {
  enabled: false,
  vatRegistrationNumber: "",
  sellerName: "",
  buildingNumber: "",
  streetName: "",
  district: "",
  city: "",
  postalCode: "",
  additionalNumber: "",
  countryCode: "SA",
}

export async function getZatcaSellerProfile(organizationId: string): Promise<ZatcaSellerProfile> {
  const row = await db.setting.findFirst({ where: { organizationId, branchId: null, key: ZATCA_SELLER_PROFILE_KEY } })
  return row ? { ...DISABLED_PROFILE, ...(row.value as Partial<ZatcaSellerProfile>) } : DISABLED_PROFILE
}

/** BR-KSA-05/06: 15 digits, first and last digit must be "3". */
export function isValidVatRegistrationNumber(value: string): boolean {
  return /^3\d{13}3$/.test(value)
}

export async function setZatcaSellerProfile(session: SessionContext, profile: ZatcaSellerProfile): Promise<void> {
  assertCan(session, "einvoicing.configure")
  if (profile.enabled) {
    if (!isValidVatRegistrationNumber(profile.vatRegistrationNumber)) {
      throw new Error("VAT registration number must be 15 digits, starting and ending with 3 (BR-KSA-05).")
    }
    if (!profile.sellerName.trim()) throw new Error("Seller name is required.")
    if (!profile.buildingNumber.trim() || profile.buildingNumber.length !== 4) {
      throw new Error("Building number must be 4 digits (KSA national address requirement).")
    }
    if (!profile.streetName.trim() || !profile.district.trim() || !profile.city.trim() || !profile.postalCode.trim()) {
      throw new Error("Street, district, city and postal code are all required for the seller's national address.")
    }
  }

  const organizationId = session.user.organizationId
  const existing = await db.setting.findFirst({ where: { organizationId, branchId: null, key: ZATCA_SELLER_PROFILE_KEY } })
  if (existing) {
    await db.setting.update({ where: { id: existing.id }, data: { value: profile as never } })
  } else {
    await db.setting.create({ data: { organizationId, branchId: null, key: ZATCA_SELLER_PROFILE_KEY, value: profile as never } })
  }
  await auditFromSession(session, existing ? "update" : "create", "zatca_seller_profile", organizationId, {
    new: { enabled: profile.enabled, vatRegistrationNumber: profile.enabled ? profile.vatRegistrationNumber : null },
  })
}
