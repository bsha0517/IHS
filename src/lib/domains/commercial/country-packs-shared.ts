import { REGULATORY_LABELS, COUNTRY_INTEGRATIONS, type RegulatoryCode } from "@/lib/domains/commercial/regulatory-shared"

/**
 * P5.7 Part 14-19: a deliberately small, static "recommended defaults per
 * country" concept — NOT a regulatory engine, NOT a fork of the product.
 * One Avant Core codebase; a Country Pack is just a bundle of sensible
 * defaults (currency, timezone) plus a pointer at which regulatory surfaces
 * (regulatory-shared.ts's existing country->integration map) are relevant,
 * reused rather than duplicated. Client-safe (no "server-only") so both the
 * provisioning wizard's client component and server pages can import it.
 */

export type CountryPackCode = "PK" | "SA" | "AE"

export type CountryPackDefinition = {
  code: CountryPackCode
  countryName: string
  currency: string
  defaultTimezone: string
  regulatorySurfaces: RegulatoryCode[]
}

export const COUNTRY_PACKS: Record<CountryPackCode, CountryPackDefinition> = {
  PK: { code: "PK", countryName: "Pakistan", currency: "PKR", defaultTimezone: "Asia/Karachi", regulatorySurfaces: COUNTRY_INTEGRATIONS.PK ?? [] },
  SA: { code: "SA", countryName: "Saudi Arabia", currency: "SAR", defaultTimezone: "Asia/Riyadh", regulatorySurfaces: COUNTRY_INTEGRATIONS.SA ?? [] },
  AE: { code: "AE", countryName: "United Arab Emirates", currency: "AED", defaultTimezone: "Asia/Dubai", regulatorySurfaces: COUNTRY_INTEGRATIONS.AE ?? [] },
}

export const ALL_COUNTRY_PACK_CODES: CountryPackCode[] = ["PK", "SA", "AE"]

/** A static, org-independent implementation-status label per regulatory surface — never "certified"/"compliant"/"approved". The one real adapter (ZATCA) is honestly capped at "sandbox/demo capability"; FBR and DHA/NABIDH are honestly "not implemented." Matches regulatory.ts's own per-organization status wording without needing an organization to check. */
export const REGULATORY_SURFACE_STATIC_STATUS: Record<RegulatoryCode, string> = {
  zatca: "Sandbox/demo capability available (P5.5-Z) — configuration required per organization",
  fbr: "Not implemented",
  dha_nabidh: "Not implemented",
}

export function getCountryPack(country: string | null | undefined): CountryPackDefinition | null {
  if (!country) return null
  const code = country.toUpperCase() as CountryPackCode
  return COUNTRY_PACKS[code] ?? null
}

export { REGULATORY_LABELS }
