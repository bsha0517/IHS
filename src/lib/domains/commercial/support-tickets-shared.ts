/**
 * P5.2: client-safe half of the support-ticket module — constants only, no
 * "server-only", no db.ts import. Split out of support-tickets.ts for the
 * exact reason P5.1's entitlements.ts/entitlements-shared.ts split exists
 * (see that file's own doc comment): a client component ("use client")
 * importing a plain constant from a "server-only" file pulls that file's
 * entire dependency chain — Prisma, the `pg` driver — into the browser
 * bundle, which fails to resolve `pg`'s Node built-ins there and breaks the
 * route's Turbopack dev compilation entirely (an ENOENT reading that
 * route's own build-manifest.json, not an obviously-related error message).
 * Any client component needing `SUPPORT_TICKET_CATEGORIES` must import it
 * from here, never from support-tickets.ts directly.
 */
export const SUPPORT_TICKET_CATEGORIES = ["onboarding", "access", "billing", "configuration", "technical", "bug", "training", "other"] as const
export type SupportTicketCategory = (typeof SUPPORT_TICKET_CATEGORIES)[number]
