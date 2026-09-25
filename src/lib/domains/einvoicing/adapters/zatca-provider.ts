import type { EInvoiceProvider, SubmitInvoiceInput, SubmitInvoiceResult } from "@/lib/domains/einvoicing/adapters/types"
import type { ZatcaCredentials } from "@/lib/domains/einvoicing/env"

/**
 * Real HTTP client for ZATCA's Integration Sandbox Reporting API, grounded
 * in the official Developer Portal Manual (2.3.10.5 "REPORTING", Chapter 3
 * "Security Requirements", and the Reporting/Clearance API FAQ entries):
 *
 * - Auth: `Authorization: Basic base64(CSID:Secret)` — "The solution will
 *   include a Basic Authentication header with the CSID as the Username and
 *   a Secret Value as the Password... Production CSID and Secret issued and
 *   all eInvoicing calls (reporting and clearance) should include the Basic
 *   Authentication header."
 * - `Accept-Version: V2` — "An additional accept-version: v2 header must be
 *   added to V2 API calls" / "V2 is currently the only valid version."
 * - Request body confirmed exactly for the Clearance API's FAQ entry:
 *   `{"invoiceHash": "string", "invoice": "string"}` (base64-encoded XML).
 *   The Reporting API is listed alongside Clearance in the same "Invoices
 *   APIs" group throughout the manual with no documented shape difference,
 *   so this client assumes the identical body shape — not independently
 *   confirmed for Reporting specifically.
 * - Response confirmed exactly for both: 200 OK with
 *   `{invoiceHash, status, warnings, errors}`.
 *
 * GAP (documented in docs/P5_5_Z_ZATCA_SANDBOX.md): the manual never states
 * the Sandbox's literal base hostname or the Reporting endpoint's exact path
 * — only the Clearance path (`/invoices/clearance/single`) appears verbatim;
 * the Swagger/OpenAPI definition that would confirm the Reporting path
 * requires a registered Sandbox account this session does not have. The
 * default path below is inferred by symmetry with the confirmed Clearance
 * path and MUST be verified against the real Swagger docs (or overridden
 * via ZATCA_REPORTING_PATH) before a genuine sandbox call is attempted.
 */
const DEFAULT_REPORTING_PATH = "/invoices/reporting/single"

export class ZatcaEInvoiceProvider implements EInvoiceProvider {
  constructor(private readonly credentials: ZatcaCredentials) {}

  async submitInvoice(input: SubmitInvoiceInput): Promise<SubmitInvoiceResult> {
    const { baseUrl, productionCsid, productionSecret } = this.credentials
    if (!baseUrl || !productionCsid || !productionSecret) {
      return { outcome: "not_configured", reason: "Production CSID/Secret or sandbox base URL missing." }
    }

    const path = process.env.ZATCA_REPORTING_PATH ?? DEFAULT_REPORTING_PATH
    const url = `${baseUrl.replace(/\/$/, "")}${path}`
    const authHeader = `Basic ${Buffer.from(`${productionCsid}:${productionSecret}`).toString("base64")}`

    let response: Response
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
          "Accept-Version": "V2",
          "Accept-Language": "en",
        },
        body: JSON.stringify({ invoiceHash: input.invoiceHash, uuid: input.uuid, invoice: input.xmlBase64 }),
      })
    } catch (error) {
      return { outcome: "failed", error: error instanceof Error ? error.message : "Network error calling ZATCA Reporting API" }
    }

    let body: { invoiceHash?: string; status?: string; warnings?: unknown; errors?: unknown } | null = null
    try {
      body = await response.json()
    } catch {
      // Non-JSON response — fall through with body left null.
    }

    if (response.status === 200 && body) {
      return { outcome: "reported", zatcaStatus: body.status ?? "UNKNOWN", warnings: body.warnings ?? null, errors: body.errors ?? null }
    }
    if (response.status === 400) {
      return { outcome: "rejected", zatcaStatus: body?.status ?? null, warnings: body?.warnings ?? null, errors: body?.errors ?? `HTTP ${response.status}` }
    }
    return { outcome: "failed", error: `ZATCA Reporting API returned HTTP ${response.status}${body ? `: ${JSON.stringify(body)}` : ""}` }
  }
}
