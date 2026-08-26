import type { ClaimSubmissionAdapter, ClaimSubmissionInput, ClaimSubmissionResult } from "@/lib/domains/claims/adapters/types"

/**
 * The only ClaimSubmissionAdapter implementation today. No live payor/
 * clearinghouse connection exists — this records that claim submission
 * happened (staff submit it externally, by portal/EDI/fax, outside this
 * system) rather than simulating a real API call and inventing a fake
 * "accepted" response (spec.md §92 "never fake API integrations"). A future
 * country-specific adapter (e.g. a real X12 837 gateway) implements the same
 * interface and is selected in `resolveAdapter()` (claims/service.ts) by
 * payor/region — resolution is centralized there so this file never needs
 * to know about routing.
 */
export class ManualSubmissionAdapter implements ClaimSubmissionAdapter {
  async submit(input: ClaimSubmissionInput): Promise<ClaimSubmissionResult> {
    void input // no live clearinghouse to send it to — see class doc comment
    return { externalReference: null, submittedAt: new Date() }
  }
}
