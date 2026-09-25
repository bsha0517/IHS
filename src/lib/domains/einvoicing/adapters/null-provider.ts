import type { EInvoiceProvider, SubmitInvoiceInput, SubmitInvoiceResult } from "@/lib/domains/einvoicing/adapters/types"

/** Same discipline as communications' NullSmsAdapter: honestly reports that no real submission was attempted, rather than fabricating a ZATCA response. */
export class NullEInvoiceProvider implements EInvoiceProvider {
  async submitInvoice(input: SubmitInvoiceInput): Promise<SubmitInvoiceResult> {
    void input
    return { outcome: "not_configured", reason: "No ZATCA sandbox credentials are configured (ZATCA_SANDBOX_BASE_URL / ZATCA_PRODUCTION_CSID / ZATCA_PRODUCTION_SECRET)." }
  }
}
