import "server-only"

/**
 * ZATCA credential material — always read from process.env, never persisted
 * to the database (see config.ts's doc comment). This build supports a
 * single active ZATCA-enabled organization (the prospect-demo/sandbox
 * scope explicitly given for P5.5-Z), the same single-tenant-credential
 * shape the rest of this codebase already uses for provider secrets (e.g.
 * communications adapters). Multi-organization ZATCA (a distinct
 * certificate per taxpayer) is a real future requirement, not something
 * this phase invents a design for — see docs/P5_5_Z_ZATCA_SANDBOX.md's
 * "Not Implemented" section.
 */
export type ZatcaCredentials = {
  baseUrl: string
  complianceCsid: string | null
  complianceSecret: string | null
  productionCsid: string | null
  productionSecret: string | null
  /** PEM-encoded EC private key used to sign the invoice hash (QR tag 7) and the CSR. Never logged, never returned to any UI. */
  privateKeyPem: string | null
}

export function getZatcaCredentials(): ZatcaCredentials {
  return {
    baseUrl: process.env.ZATCA_SANDBOX_BASE_URL ?? "",
    complianceCsid: process.env.ZATCA_COMPLIANCE_CSID ?? null,
    complianceSecret: process.env.ZATCA_COMPLIANCE_SECRET ?? null,
    productionCsid: process.env.ZATCA_PRODUCTION_CSID ?? null,
    productionSecret: process.env.ZATCA_PRODUCTION_SECRET ?? null,
    privateKeyPem: process.env.ZATCA_PRIVATE_KEY_PEM ?? null,
  }
}

/** True once enough credential material exists to make a real Reporting API call (production CSID/secret — compliance-only credentials can sign but not report/clear). */
export function hasProductionCredentials(creds: ZatcaCredentials): boolean {
  return Boolean(creds.baseUrl && creds.productionCsid && creds.productionSecret)
}

export function hasSigningKey(creds: ZatcaCredentials): boolean {
  return Boolean(creds.privateKeyPem)
}
