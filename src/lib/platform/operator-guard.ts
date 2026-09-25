import "server-only"
import { getCurrentPlatformSession, type PlatformSessionContext } from "@/lib/auth/platform-session"

/**
 * P5.1 §21/§84: the one authorization chokepoint for every platform route
 * and Server Action — mirrors `permissions-core.ts`'s `can()`/`assertCan()`
 * role in the clinic app. There is no permission-code check here (a single
 * `PlatformOperator` role tier for V1 — §19's "do not overengineer"); the
 * whole security boundary is simply "does a valid, non-revoked
 * PlatformSession exist," which by construction only a row in
 * `platform_operator` can ever produce (see that model's own doc comment).
 */
export class PlatformForbiddenError extends Error {
  constructor() {
    super("Platform operator session required.")
    this.name = "PlatformForbiddenError"
  }
}

export async function requirePlatformOperator(): Promise<PlatformSessionContext> {
  const session = await getCurrentPlatformSession()
  if (!session) throw new PlatformForbiddenError()
  return session
}
