/**
 * Provider abstraction for e-invoicing submission — mirrors
 * src/lib/domains/communications/adapters/types.ts exactly (same "do not
 * fake API integrations" discipline, same shape: a real provider makes a
 * real HTTP call and honestly reports what came back; a Null* provider
 * honestly reports it never attempted anything). ZATCA is the only
 * implementation this phase ships, but nothing here is ZATCA-specific by
 * name, so a future jurisdiction's provider (a different e-invoicing
 * mandate) can implement the same interface without touching billing code.
 */
export type SubmitInvoiceInput = {
  invoiceHash: string
  uuid: string
  xmlBase64: string
}

export type SubmitInvoiceResult =
  | { outcome: "reported"; zatcaStatus: string; warnings: unknown; errors: unknown }
  | { outcome: "cleared"; zatcaStatus: string; warnings: unknown; errors: unknown }
  | { outcome: "rejected"; zatcaStatus: string | null; warnings: unknown; errors: unknown }
  | { outcome: "not_configured"; reason: string }
  | { outcome: "failed"; error: string }

export interface EInvoiceProvider {
  submitInvoice(input: SubmitInvoiceInput): Promise<SubmitInvoiceResult>
}
