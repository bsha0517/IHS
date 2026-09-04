import "server-only"
import { db } from "@/lib/db"
import { Prisma } from "@/generated/prisma/client"

/**
 * P3.11 §41: idempotent notification-creation primitives, deliberately kept
 * in their own leaf file (no imports beyond the Prisma client) so that
 * `platform/outbox.ts` and `platform/event-handlers.ts` — both of which
 * call these directly from outbox handlers — never pull in
 * `notifications/service.ts`'s own dependency on
 * `domains/accounting/exceptions.ts`, which itself imports FROM
 * `platform/outbox.ts` (retryOutboxEvent/processPendingOutboxEvents). That
 * would be a real circular import (outbox.ts -> service.ts ->
 * exceptions.ts -> outbox.ts); this file exists specifically so outbox.ts
 * and event-handlers.ts only ever depend on this narrow, dependency-free
 * module. `notifications/service.ts` (the read-side/dashboard layer) also
 * imports from here and re-exports these for every other caller.
 */

type Db = Prisma.TransactionClient | typeof db

export type NotificationCreateInput = {
  organizationId: string
  recipientUserId: string
  type: string
  title: string
  body: string
  referenceType?: string | null
  referenceId?: string | null
}

/** Single-recipient idempotent create — used by every producer with exactly one recipient (e.g. "the ordering provider"). */
export async function createNotificationOnce(dbOrTx: Db, input: NotificationCreateInput): Promise<void> {
  if (input.referenceType && input.referenceId) {
    const existing = await dbOrTx.notification.findFirst({
      where: {
        recipientUserId: input.recipientUserId,
        type: input.type,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
      },
      select: { id: true },
    })
    if (existing) return
  }
  await dbOrTx.notification.create({
    data: { ...input, referenceType: input.referenceType ?? null, referenceId: input.referenceId ?? null },
  })
}

/**
 * Fan-out idempotent create — used by every producer with multiple
 * recipients (admins, verifiers, approvers). Every entry MUST share the same
 * (type, referenceType, referenceId), differing only by recipientUserId —
 * true for every current caller (one real-world event, one fixed set of
 * recipients) — enforced with an explicit check rather than silently
 * batching a mixed list incorrectly. Existing-row lookup is a single batched
 * query across every recipient, not one query per recipient.
 */
export async function createNotificationsOnce(dbOrTx: Db, inputs: NotificationCreateInput[]): Promise<void> {
  if (inputs.length === 0) return
  const [first, ...rest] = inputs
  const homogeneous = rest.every((i) => i.type === first.type && i.referenceType === first.referenceType && i.referenceId === first.referenceId)
  if (!homogeneous) {
    throw new Error("createNotificationsOnce: all entries in one batch must share the same (type, referenceType, referenceId)")
  }

  let toCreate = inputs
  if (first.referenceType && first.referenceId) {
    const existing = await dbOrTx.notification.findMany({
      where: {
        type: first.type,
        referenceType: first.referenceType,
        referenceId: first.referenceId,
        recipientUserId: { in: inputs.map((i) => i.recipientUserId) },
      },
      select: { recipientUserId: true },
    })
    const already = new Set(existing.map((e) => e.recipientUserId))
    toCreate = inputs.filter((i) => !already.has(i.recipientUserId))
  }
  if (toCreate.length === 0) return
  await dbOrTx.notification.createMany({
    data: toCreate.map((i) => ({ ...i, referenceType: i.referenceType ?? null, referenceId: i.referenceId ?? null })),
  })
}
