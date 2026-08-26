import type { CommunicationAdapter, SendInput, SendResult } from "@/lib/domains/communications/adapters/types"

/** No live email provider (SES/SendGrid or similar) is connected — see adapters/types.ts's doc comment. */
export class NullEmailAdapter implements CommunicationAdapter {
  async send(input: SendInput): Promise<SendResult> {
    void input
    return { status: "failed", error: "No email provider configured — message logged only, not transmitted." }
  }
}
