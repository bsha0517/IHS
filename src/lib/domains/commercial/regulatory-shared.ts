/**
 * P5.6: client-safe half of regulatory.ts — same "types/constants only, no
 * server-only import" split as entitlements-shared.ts, so the provisioning
 * wizard's review step can show "what regulatory integrations this country
 * has" without pulling einvoicing/config.ts's server-only chain into the
 * browser bundle. Server code should prefer regulatory.ts, which reuses
 * these same constants.
 */

export type RegulatoryCode = "zatca" | "fbr" | "dha_nabidh"

export const REGULATORY_LABELS: Record<RegulatoryCode, string> = {
  zatca: "ZATCA (Saudi Arabia e-invoicing)",
  fbr: "FBR (Pakistan tax authority)",
  dha_nabidh: "DHA / NABIDH (UAE healthcare)",
}

/** ISO 3166-1 alpha-2 -> which regulatory integrations are even relevant for that country. */
export const COUNTRY_INTEGRATIONS: Record<string, RegulatoryCode[]> = {
  SA: ["zatca"],
  PK: ["fbr"],
  AE: ["dha_nabidh"],
}

export const ALL_REGULATORY_CODES: RegulatoryCode[] = ["zatca", "fbr", "dha_nabidh"]
