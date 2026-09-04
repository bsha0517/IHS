import "server-only"
import { db } from "@/lib/db"
import type { $Enums } from "@/generated/prisma/client"

/**
 * P4.3 §9: IP-based brute-force throttling for the two public login
 * surfaces (staff `/login`, patient `/portal/login`). Both already had a
 * per-ACCOUNT throttle (5 failed attempts -> 15-minute lockout, in
 * `auth/service.ts`'s `login()` and `auth/portal-service.ts`'s
 * `portalLogin()`) — that alone doesn't stop an attacker distributing
 * guesses across many DIFFERENT accounts from one IP (credential
 * stuffing), since each individual account only ever sees one failed
 * attempt from that pattern. This closes that gap without inventing a
 * second, parallel identifier: it reuses `LoginHistory`, the table every
 * attempt (both channels, since this batch) already writes to, storage-
 * backed rather than process-memory specifically so it behaves correctly
 * across multiple/serverless application instances (§9's own requirement)
 * — no Redis, no new infrastructure.
 *
 * Deliberately NOT a permanent block: the window slides (old attempts age
 * out on their own as `createdAt` falls outside it), so a legitimate user
 * sharing a NAT'd/clinic network IP with someone else's failed attempts is
 * never locked out indefinitely — see §10's "avoid... an easy
 * denial-of-service attack against known staff accounts."
 */
const IP_WINDOW_MS = 10 * 60 * 1000 // 10 minutes
const IP_MAX_FAILURES = 20

export type RateLimitResult = { throttled: boolean; retryAfterSeconds?: number }

/**
 * Counts recent failed attempts from this IP on this channel. Returns
 * `{throttled: false}` when `ip` is unknown/unavailable (e.g. a proxy that
 * strips forwarding headers) — the per-account lockout still applies in
 * that case, this is defense-in-depth on top of it, not a replacement.
 */
export async function checkIpRateLimit(channel: $Enums.LoginChannel, ip: string | null | undefined): Promise<RateLimitResult> {
  if (!ip) return { throttled: false }

  const since = new Date(Date.now() - IP_WINDOW_MS)
  const failureCount = await db.loginHistory.count({
    where: { ip, channel, success: false, createdAt: { gte: since } },
  })

  if (failureCount >= IP_MAX_FAILURES) {
    return { throttled: true, retryAfterSeconds: Math.ceil(IP_WINDOW_MS / 1000) }
  }
  return { throttled: false }
}
