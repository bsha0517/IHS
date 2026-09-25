import "server-only"
import { db } from "@/lib/db"
import { writeAuditLog } from "@/lib/platform/audit"
import { assertCan } from "@/lib/platform/permissions-core"
import { nextPlatformNumber } from "@/lib/platform/sequences"
import type { SupportTicketCategory } from "@/lib/domains/commercial/support-tickets-shared"
import type { SessionContext } from "@/lib/auth/session"
import type { $Enums } from "@/generated/prisma/client"

/**
 * P5.2 §7/§8: a lightweight platform support system — not a full helpdesk.
 * Two distinct callers, two distinct trust boundaries, kept in separate
 * function groups rather than one generic "get ticket" that branches
 * internally on caller type (easy to audit, hard to accidentally cross):
 *
 * - Platform-operator functions (`requirePlatformOperator()`-gated): full
 *   read/write across every organization's tickets, including internal
 *   notes.
 * - Clinic-user functions (`SessionContext`-gated, `support_ticket.manage`
 *   permission): read/write ONLY the caller's own organization's tickets,
 *   and NEVER an internal-visibility note — every clinic-facing query
 *   filters `visibility: "customer"` at the database level, not in the
 *   client.
 *
 * `category`/`priority`/`status` are validated against the fixed lists
 * below (not free text) even though `category` is a plain schema string —
 * same "extensible-but-bounded string" precedent as `ModuleKey`.
 *
 * Every platform-operator function below takes `operatorId` as an explicit
 * parameter rather than resolving it internally via `requirePlatformOperator()`
 * — see `onboarding-checklist.ts`'s own doc comment for why (testability;
 * `requirePlatformOperator()` needs Next's request-scoped `cookies()` and
 * cannot run in an integration test). The Server Action caller resolves the
 * real, cookie-verified operator first and passes its id through.
 */

export { SUPPORT_TICKET_CATEGORIES, type SupportTicketCategory } from "@/lib/domains/commercial/support-tickets-shared"

const TICKET_INCLUDE = { notes: { orderBy: { createdAt: "asc" as const } } }

// ---------------------------------------------------------------------------
// Platform operator side
// ---------------------------------------------------------------------------

export type CreateSupportTicketInput = {
  organizationId: string
  title: string
  description: string
  category: SupportTicketCategory
  priority: $Enums.SupportTicketPriority
}

export async function createSupportTicket(operatorId: string, input: CreateSupportTicketInput) {
  const ticketNumber = await nextPlatformNumber({ sequenceType: "SUP", prefix: "SUP" })

  const ticket = await db.supportTicket.create({
    data: {
      organizationId: input.organizationId,
      ticketNumber,
      title: input.title,
      description: input.description,
      category: input.category,
      priority: input.priority,
      createdByOperatorId: operatorId,
    },
  })

  await writeAuditLog({
    organizationId: input.organizationId,
    userId: operatorId,
    action: "platform.support_ticket.created",
    entityType: "support_ticket",
    entityId: ticket.id,
    newValues: { ticketNumber, title: input.title, category: input.category, priority: input.priority },
  })
  return ticket
}

export async function listSupportTicketsForPlatform(filters: { organizationId?: string; status?: $Enums.SupportTicketStatus; assignedOperatorId?: string } = {}) {
  return db.supportTicket.findMany({
    where: {
      organizationId: filters.organizationId,
      status: filters.status,
      assignedOperatorId: filters.assignedOperatorId,
    },
    include: { organization: { select: { id: true, displayName: true } } },
    orderBy: { createdAt: "desc" },
  })
}

export async function getSupportTicketForPlatform(ticketId: string) {
  return db.supportTicket.findUniqueOrThrow({
    where: { id: ticketId },
    include: { ...TICKET_INCLUDE, organization: { select: { id: true, displayName: true } } },
  })
}

export async function updateSupportTicketStatus(ticketId: string, operatorId: string, status: $Enums.SupportTicketStatus) {
  const before = await db.supportTicket.findUniqueOrThrow({ where: { id: ticketId } })
  const updated = await db.supportTicket.update({ where: { id: ticketId }, data: { status } })

  await writeAuditLog({
    organizationId: updated.organizationId,
    userId: operatorId,
    action: "platform.support_ticket.updated",
    entityType: "support_ticket",
    entityId: updated.id,
    oldValues: { status: before.status },
    newValues: { status: updated.status },
  })
  return updated
}

export async function assignSupportTicket(ticketId: string, operatorId: string, assignedOperatorId: string | null) {
  const before = await db.supportTicket.findUniqueOrThrow({ where: { id: ticketId } })
  const updated = await db.supportTicket.update({ where: { id: ticketId }, data: { assignedOperatorId } })

  await writeAuditLog({
    organizationId: updated.organizationId,
    userId: operatorId,
    action: "platform.support_ticket.assigned",
    entityType: "support_ticket",
    entityId: updated.id,
    oldValues: { assignedOperatorId: before.assignedOperatorId },
    newValues: { assignedOperatorId: updated.assignedOperatorId },
  })
  return updated
}

export async function addSupportTicketNoteFromOperator(ticketId: string, operatorId: string, body: string, visibility: $Enums.SupportTicketNoteVisibility) {
  const ticket = await db.supportTicket.findUniqueOrThrow({ where: { id: ticketId } })

  const note = await db.supportTicketNote.create({
    data: { ticketId, organizationId: ticket.organizationId, body, visibility, authorOperatorId: operatorId },
  })
  await writeAuditLog({
    organizationId: ticket.organizationId,
    userId: operatorId,
    action: "platform.support_ticket.updated",
    entityType: "support_ticket_note",
    entityId: note.id,
    newValues: { visibility },
  })
  return note
}

// ---------------------------------------------------------------------------
// Clinic-user side — organization-scoped, no internal notes ever exposed.
// ---------------------------------------------------------------------------

export type CreateClinicSupportTicketInput = {
  title: string
  description: string
  category: SupportTicketCategory
  priority: $Enums.SupportTicketPriority
}

export async function createSupportTicketFromClinic(session: SessionContext, input: CreateClinicSupportTicketInput) {
  assertCan(session, "support_ticket.manage")
  const organizationId = session.user.organizationId
  const ticketNumber = await nextPlatformNumber({ sequenceType: "SUP", prefix: "SUP" })

  const ticket = await db.supportTicket.create({
    data: {
      organizationId,
      ticketNumber,
      title: input.title,
      description: input.description,
      category: input.category,
      priority: input.priority,
      createdByUserId: session.user.id,
    },
  })

  await writeAuditLog({
    organizationId,
    userId: session.user.id,
    action: "platform.support_ticket.created",
    entityType: "support_ticket",
    entityId: ticket.id,
    newValues: { ticketNumber, title: input.title, category: input.category, priority: input.priority },
  })
  return ticket
}

/** Own-organization tickets only, enforced by the `organizationId` filter below — never trusts any client-supplied org id. */
export async function listSupportTicketsForClinic(session: SessionContext) {
  assertCan(session, "support_ticket.manage")
  return db.supportTicket.findMany({
    where: { organizationId: session.user.organizationId },
    orderBy: { createdAt: "desc" },
  })
}

/**
 * §8: the one clinic-facing detail read. `notes` is filtered to
 * `visibility: "customer"` in the DATABASE QUERY itself — an internal note
 * is never fetched into memory for this code path at all, not merely
 * hidden by the UI.
 */
export async function getSupportTicketForClinic(session: SessionContext, ticketId: string) {
  assertCan(session, "support_ticket.manage")
  return db.supportTicket.findFirstOrThrow({
    where: { id: ticketId, organizationId: session.user.organizationId },
    include: { notes: { where: { visibility: "customer" }, orderBy: { createdAt: "asc" } } },
  })
}

export async function addSupportTicketNoteFromClinic(session: SessionContext, ticketId: string, body: string) {
  assertCan(session, "support_ticket.manage")
  const ticket = await db.supportTicket.findFirstOrThrow({ where: { id: ticketId, organizationId: session.user.organizationId } })

  // A clinic reply always lands as a customer-visible note — a clinic user
  // has no way to write an internal-only note (that field doesn't exist on
  // this code path's own input type at all).
  const note = await db.supportTicketNote.create({
    data: { ticketId: ticket.id, organizationId: session.user.organizationId, body, visibility: "customer", authorUserId: session.user.id },
  })

  // A clinic reply reopens a resolved/closed ticket to "waiting on customer"
  // response having been read — moves it back into the operator's queue
  // rather than leaving a reply silently attached to a closed ticket.
  if (ticket.status === "resolved" || ticket.status === "closed") {
    await db.supportTicket.update({ where: { id: ticket.id }, data: { status: "open" } })
  }

  await writeAuditLog({
    organizationId: session.user.organizationId,
    userId: session.user.id,
    action: "platform.support_ticket.updated",
    entityType: "support_ticket_note",
    entityId: note.id,
    newValues: { visibility: "customer" },
  })
  return note
}
