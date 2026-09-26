import "server-only"
import { requirePlatformOperator } from "@/lib/platform/operator-guard"
import { getZatcaSellerProfile } from "@/lib/domains/einvoicing/config"
import { getZatcaCredentials, hasProductionCredentials, hasSigningKey } from "@/lib/domains/einvoicing/env"
import { REGULATORY_LABELS, COUNTRY_INTEGRATIONS, ALL_REGULATORY_CODES, type RegulatoryCode } from "@/lib/domains/commercial/regulatory-shared"

/**
 * P5.6: the SaaS configuration *surface* for country-driven regulatory
 * integrations — not new integration work. ZATCA (P5.5-Z) is the only real
 * adapter that exists; this reuses its existing organization-level config
 * (`einvoicing/config.ts`'s `Setting`-backed seller profile) rather than
 * building a second configuration system. FBR and DHA/NABIDH have no
 * adapter at all and are always reported `not_implemented` — this file
 * never fabricates a working integration for either.
 *
 * Wording discipline (P5.6 Part 4/5): never "certified"/"approved"/
 * "compliant". ZATCA's status is deliberately capped at "configured" (env
 * vars present), never "connected" or "verified" — this build has no
 * standalone connectivity check, only a real submission attempt made when
 * an actual invoice is issued (see einvoicing/service.ts). Environment is
 * always reported "sandbox" for ZATCA: P5.5-Z only ever targets ZATCA's
 * Integration Sandbox (see docs/P5_5_Z_ZATCA_SANDBOX.md); production is
 * explicitly out of scope for this phase (P5.6 Part 20) and is never
 * reported as available, regardless of which credentials happen to be set.
 *
 * The country->integration map and labels live in regulatory-shared.ts (no
 * "server-only") so the provisioning wizard's client-side review step can
 * show the same landscape before an organization even exists — see that
 * file's own doc comment.
 */

export type { RegulatoryCode } from "@/lib/domains/commercial/regulatory-shared"

export type RegulatoryStatus =
  | "not_available" // this country has no integration of this kind
  | "not_implemented" // available in principle, but no adapter exists (FBR, DHA/NABIDH)
  | "not_configured" // adapter exists, org has not enabled it
  | "sandbox_configuration_pending" // org enabled it, credentials incomplete
  | "sandbox_configured" // org enabled it, sandbox credentials present (not a verified live connection)

export type RegulatoryIntegration = {
  code: RegulatoryCode
  label: string
  status: RegulatoryStatus
  /** Always "sandbox" for the one real adapter (ZATCA) this build has — production is out of scope (P5.6 Part 20). */
  environment: "sandbox" | null
  /** Where a platform operator or clinic admin actually configures this, if anywhere. */
  configureHref: string | null
}

/**
 * Returns all three known regulatory integrations for an organization,
 * marking the ones its country doesn't apply to as `not_available` rather
 * than omitting them — a platform operator should see the full landscape,
 * not wonder why a row is missing.
 */
export async function getRegulatoryIntegrations(organizationId: string, country: string | null): Promise<RegulatoryIntegration[]> {
  await requirePlatformOperator()
  const applicable = new Set(country ? (COUNTRY_INTEGRATIONS[country.toUpperCase()] ?? []) : [])

  const results: RegulatoryIntegration[] = []
  for (const code of ALL_REGULATORY_CODES) {
    if (!applicable.has(code)) {
      results.push({ code, label: REGULATORY_LABELS[code], status: "not_available", environment: null, configureHref: null })
      continue
    }

    if (code === "zatca") {
      const profile = await getZatcaSellerProfile(organizationId)
      if (!profile.enabled) {
        results.push({ code, label: REGULATORY_LABELS[code], status: "not_configured", environment: null, configureHref: "/einvoicing" })
        continue
      }
      const creds = getZatcaCredentials()
      const configured = hasProductionCredentials(creds) && hasSigningKey(creds)
      results.push({
        code,
        label: REGULATORY_LABELS[code],
        status: configured ? "sandbox_configured" : "sandbox_configuration_pending",
        environment: "sandbox",
        configureHref: "/einvoicing",
      })
      continue
    }

    // fbr, dha_nabidh — no adapter exists yet (P5.6 Part 5/20).
    results.push({ code, label: REGULATORY_LABELS[code], status: "not_implemented", environment: null, configureHref: null })
  }
  return results
}

export const REGULATORY_STATUS_LABEL: Record<RegulatoryStatus, string> = {
  not_available: "Not applicable for this country",
  not_implemented: "Not implemented",
  not_configured: "Not configured",
  sandbox_configuration_pending: "Sandbox configuration pending",
  sandbox_configured: "Sandbox configured",
}
