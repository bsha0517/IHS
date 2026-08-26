import type { CommunicationAdapter, SendInput, SendResult } from "@/lib/domains/communications/adapters/types"

/** No live WhatsApp Business API provider is connected — see adapters/types.ts's doc comment. */
export class NullWhatsAppAdapter implements CommunicationAdapter {
  async send(input: SendInput): Promise<SendResult> {
    void input
    return { status: "failed", error: "No WhatsApp provider configured — message logged only, not transmitted." }
  }
}
