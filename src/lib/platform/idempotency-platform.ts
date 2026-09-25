import "server-only"
import { Prisma } from "@/generated/prisma/client"
import { db } from "@/lib/db"
import { DuplicateRequestError } from "@/lib/platform/idempotency"

export { DuplicateRequestError }

/**
 * P5.1 §25/§60/§61: identical mechanism to `idempotency.ts`'s
 * claim/record/resolve pattern, scoped by `operatorId` instead of
 * `organizationId` — see `PlatformIdempotencyKey`'s own schema doc comment
 * for why this can't simply reuse the existing table (clinic provisioning
 * has no organization yet at the moment the key must be claimed). Call as
 * the very first statement inside the caller's transaction, exactly like
 * the original.
 */
export async function claimPlatformIdempotencyKey(
  tx: Prisma.TransactionClient,
  input: { operatorId: string; scope: string; key: string }
): Promise<void> {
  await tx.platformIdempotencyKey.create({
    data: { operatorId: input.operatorId, scope: input.scope, key: input.key },
  })
}

export async function recordPlatformIdempotentResult(
  tx: Prisma.TransactionClient,
  input: { operatorId: string; scope: string; key: string; resultId: string }
): Promise<void> {
  await tx.platformIdempotencyKey.update({
    where: { operatorId_scope_key: { operatorId: input.operatorId, scope: input.scope, key: input.key } },
    data: { resultId: input.resultId },
  })
}

export async function resolveDuplicatePlatformRequest(input: { operatorId: string; scope: string; key: string }): Promise<string> {
  const existing = await db.platformIdempotencyKey.findUnique({
    where: { operatorId_scope_key: { operatorId: input.operatorId, scope: input.scope, key: input.key } },
  })
  if (existing?.resultId) return existing.resultId
  throw new DuplicateRequestError()
}

/** Mirrors `isIdempotencyKeyConflict` exactly, matched against `PlatformIdempotencyKey` instead. */
export function isPlatformIdempotencyKeyConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && error.meta?.modelName === "PlatformIdempotencyKey"
}
