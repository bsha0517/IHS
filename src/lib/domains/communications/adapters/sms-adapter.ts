import type { CommunicationAdapter, SendInput, SendResult } from "@/lib/domains/communications/adapters/types"

/** No live SMS provider (Twilio or similar) is connected — see adapters/types.ts's doc comment. */
export class NullSmsAdapter implements CommunicationAdapter {
  async send(input: SendInput): Promise<SendResult> {
    void input
    return { status: "failed", error: "No SMS provider configured — message logged only, not transmitted." }
  }
}
