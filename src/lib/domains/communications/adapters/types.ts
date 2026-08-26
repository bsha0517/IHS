/**
 * "Use provider adapters" (spec.md §56). A real SMS/WhatsApp/Email provider
 * (Twilio, Meta WhatsApp Business API, SendGrid/SES) needs real credentials
 * this build doesn't have and isn't going to fake — spec.md §56's own
 * explicit "do not fake successful external API delivery" and §92's "never
 * fake API integrations" apply directly. This interface is the seam a real
 * provider integration plugs into; every adapter shipped today (sms/
 * whatsapp/email) is a `Null*Adapter` that honestly reports it couldn't
 * actually send anything, rather than pretending success.
 */
export type SendInput = {
  to: string
  subject: string | null
  body: string
}

export type SendResult =
  | { status: "sent"; providerReference: string }
  | { status: "failed"; error: string }

export interface CommunicationAdapter {
  send(input: SendInput): Promise<SendResult>
}
