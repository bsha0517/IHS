import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { retryOutboxEvent, processPendingOutboxEvents } from "@/lib/platform/outbox"
import type { SessionContext } from "@/lib/auth/session"

const PAGE_SIZE = 50

/**
 * P3.9 §19-24: every eventType whose handler (event-handlers.ts) ends in a
 * call to posting-service.ts — the exact set an Accountant needs visibility
 * into, not the full outbox (notifications, appointment reminders, leave
 * conflicts, ...) `/admin/system-events` already shows to Admin. Kept next
 * to that handler registration rather than re-derived, since this list is
 * only correct as long as it matches what actually posts to accounting.
 */
export const ACCOUNTING_EVENT_TYPES = [
  "InvoiceIssued",
  "InvoiceVoided",
  "PaymentReceived",
  "RefundCompleted",
  "GoodsReceiptCompleted",
  "SupplierInvoiceCreated",
  "SupplierPaymentRecorded",
  "PackageSessionConsumed",
  "PayrollApproved",
  "PayrollPaid",
  "ProductSold",
  "ProductSaleVoided",
  "InventoryAdjusted",
] as const

const ACCOUNTING_EVENT_TYPE_LABELS: Record<string, string> = {
  InvoiceIssued: "Invoice Posting",
  InvoiceVoided: "Invoice Void Reversal",
  PaymentReceived: "Payment Posting",
  RefundCompleted: "Refund Posting",
  GoodsReceiptCompleted: "Goods Receipt Posting",
  SupplierInvoiceCreated: "Supplier Invoice (AP) Posting",
  SupplierPaymentRecorded: "Supplier Payment Posting",
  PackageSessionConsumed: "Package Revenue Recognition",
  PayrollApproved: "Payroll Approval Posting",
  PayrollPaid: "Payroll Payment Posting",
  ProductSold: "Product Sale (COGS) Posting",
  ProductSaleVoided: "Product Sale Void (COGS Reversal)",
  InventoryAdjusted: "Inventory Adjustment Posting",
}

export function accountingEventTypeLabel(eventType: string): string {
  return ACCOUNTING_EVENT_TYPE_LABELS[eventType] ?? eventType
}

/**
 * P3.9 §20: "if there's already an outbox/admin queue page, reuse it rather
 * than building another queue. Create a narrowed Accountant-appropriate
 * view/filter if necessary." `/admin/system-events` already exists but is
 * gated on `system_events.view`/`system_events.retry`, which Accountant
 * does not hold (seed.ts) and should not be broad-granted just to see
 * accounting failures mixed in with HR/clinical/notification ones — this is
 * that narrowed view: same `outbox_event` table, same eventType/status/
 * attempts/lastError/timestamps fields, filtered to only the event types
 * that actually reach the posting service, gated on `accounting.view`
 * (which Accountant already holds) instead.
 */
export async function listAccountingExceptions(
  session: SessionContext,
  filters: { status?: string; page?: number } = {}
) {
  assertCan(session, "accounting.view")
  const page = Math.max(1, filters.page ?? 1)

  const where = {
    organizationId: session.user.organizationId,
    eventType: { in: [...ACCOUNTING_EVENT_TYPES] },
    status: filters.status ? (filters.status as never) : undefined,
  }

  const [events, total, statusCounts] = await Promise.all([
    db.outboxEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    db.outboxEvent.count({ where }),
    db.outboxEvent.groupBy({
      by: ["status"],
      where: { organizationId: session.user.organizationId, eventType: { in: [...ACCOUNTING_EVENT_TYPES] } },
      _count: true,
    }),
  ])

  const needsAttention = statusCounts
    .filter((s) => s.status === "failed" || s.status === "dead_letter")
    .reduce((sum, s) => sum + s._count, 0)

  return { events, total, page, pageSize: PAGE_SIZE, totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)), needsAttention }
}

/**
 * Same mechanism `/admin/system-events`'s RetryButton uses
 * (`retryOutboxEvent` — resets attempts and re-queues; the next dispatch
 * pass, inline or swept, actually re-runs the handler). Never a second
 * retry implementation — this only narrows who can reach it and to which
 * events, via `accounting.post` (which Accountant holds) instead of
 * `system_events.retry`. Scoped to accounting event types only, so this
 * permission can never be used to retry an unrelated (HR/clinical/
 * notification) event.
 */
export async function retryAccountingException(session: SessionContext, eventId: string): Promise<void> {
  assertCan(session, "accounting.post")
  const event = await db.outboxEvent.findFirstOrThrow({
    where: { id: eventId, organizationId: session.user.organizationId, eventType: { in: [...ACCOUNTING_EVENT_TYPES] } },
  })
  await retryOutboxEvent(event.id)
  await auditFromSession(session, "retry", "outbox_event", event.id, {
    old: { status: event.status, attempts: event.attempts },
    new: { status: "pending", attempts: 0 },
  })
}

/** Same sweep `/admin/system-events`'s SweepButton triggers (`processPendingOutboxEvents`) — organization-agnostic by design (see outbox.ts), so this just narrows who in THIS organization can trigger it, not what it does. */
export async function sweepAccountingExceptions(session: SessionContext): Promise<{ recovered: number; processed: number }> {
  assertCan(session, "accounting.post")
  const result = await processPendingOutboxEvents()
  await auditFromSession(session, "sweep", "outbox_event", "*", { new: result })
  return result
}
