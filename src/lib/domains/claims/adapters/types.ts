/**
 * "Create adapters for future country-specific integrations" (spec.md §39).
 * A real payor/clearinghouse integration (X12 837/835, a national e-claims
 * gateway, an insurer's own API) is country- and payor-specific and none
 * exists to connect to yet — spec.md §92 forbids faking one. This interface
 * is the seam a future adapter plugs into; `ManualSubmissionAdapter`
 * (adapters/manual-adapter.ts) is the only implementation today, and is
 * honest about being manual rather than pretending to call a real service.
 */
export type ClaimSubmissionInput = {
  claimId: string
  claimNumber: string
  payorName: string
  submittedAmount: number
}

export type ClaimSubmissionResult = {
  externalReference: string | null
  submittedAt: Date
}

export interface ClaimSubmissionAdapter {
  submit(input: ClaimSubmissionInput): Promise<ClaimSubmissionResult>
}
