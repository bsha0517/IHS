import "server-only"
import { Prisma } from "@/generated/prisma/client"
import { db } from "@/lib/db"

export class DuplicateRequestError extends Error {
  constructor(message = "This request is already being submitted — please wait a moment and try again.") {
    super(message)
    this.name = "DuplicateRequestError"
  }
}

/**
 * P1 §33: business-level idempotency for client-initiated "create a new
 * record" actions that have nothing pre-existing to atomically claim —
 * unlike `dispenseRecord`'s verified->dispensed claim or `completeRefund`'s
 * authorized->completed claim (both already immune to double-click/retry:
 * the SECOND call finds the row no longer in the claimable status and fails
 * cleanly), a goods receipt, a payment, or a package-session consumption
 * each creates a brand-new row every time — there is no status to guard.
 * The caller supplies `key` (a UUID generated ONCE per user action on the
 * client — a form's mount, not its render — and resubmitted UNCHANGED on
 * any retry of that same attempt; a fresh key every retry defeats this
 * entirely) identifying "this one physical attempt," distinct from
 * `referenceType`/`referenceId` idempotency on the outbox side (which
 * guards a committed event against *redelivery*, not the original request
 * against being submitted twice).
 *
 * Call this as the very FIRST statement inside the caller's own
 * transaction — nothing else must run before it. If the insert here fails
 * (another request already claimed this exact key), the whole transaction
 * aborts immediately with nothing else attempted in it, so there is no
 * "statement after a failed statement" hazard (the same lesson
 * `sequences.ts`'s `nextNumber()` P1 §30 fix already established) — the
 * caller's own catch block (outside the transaction) calls
 * `resolveDuplicateRequest` to decide what to report.
 */
export async function claimIdempotencyKey(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; scope: string; key: string }
): Promise<void> {
  await tx.idempotencyKey.create({
    data: { organizationId: input.organizationId, scope: input.scope, key: input.key },
  })
}

/** Records the id of whatever `claimIdempotencyKey` guarded, in the SAME transaction as the real work — so a crash between the two can never happen: either both commit, or neither does. */
export async function recordIdempotentResult(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; scope: string; key: string; resultId: string }
): Promise<void> {
  await tx.idempotencyKey.update({
    where: { organizationId_scope_key: { organizationId: input.organizationId, scope: input.scope, key: input.key } },
    data: { resultId: input.resultId },
  })
}

/**
 * Called from OUTSIDE the failed transaction (a fresh statement, not a
 * continuation of the poisoned one) after `claimIdempotencyKey` throws.
 * If the first attempt already committed a result, returns its id — the
 * caller should treat this as a successful replay, not an error, and
 * re-fetch/return that existing record rather than creating a new one. If
 * the first attempt is still in flight (a genuinely concurrent double-click,
 * not a delayed retry), throws `DuplicateRequestError`.
 */
export async function resolveDuplicateRequest(input: { organizationId: string; scope: string; key: string }): Promise<string> {
  const existing = await db.idempotencyKey.findUnique({
    where: { organizationId_scope_key: { organizationId: input.organizationId, scope: input.scope, key: input.key } },
  })
  if (existing?.resultId) return existing.resultId
  throw new DuplicateRequestError()
}

/**
 * True only for the specific unique-constraint violation `claimIdempotencyKey`
 * can produce — never mistake an unrelated P2002 elsewhere in the same
 * transaction for a duplicate-request. Matched by `error.meta.modelName ===
 * "IdempotencyKey"`, not by introspecting which columns the violated
 * constraint covers: `claimIdempotencyKey`'s own doc comment already
 * guarantees it runs as the very first statement in the caller's
 * transaction, so a P2002 against this exact model can only ever be the one
 * unique constraint this table has (`organizationId_scope_key`) — no other
 * write happens before it to produce a different one.
 *
 * P4.9.1: previously matched via
 * `error.meta.driverAdapterError.cause.constraint.fields` (this project's
 * Prisma 7 + `@prisma/adapter-pg` setup nests unique-violation detail there,
 * not at the older binary-engine `error.meta.target` shape) — that field
 * list is present when the violated table has Row Level Security disabled,
 * but empirically verified (`scripts/_tmp_repro_idem2.ts`, deterministic
 * across repeated runs) to go MISSING — `cause` still reports
 * `kind: "UniqueConstraintViolation"` and the right Postgres error code
 * (`23505`), just no `constraint` object at all — the moment RLS is enabled
 * on that table, which P4.9.1 now does for every table including this one.
 * Silently broke this exact detection (and therefore duplicate-request
 * protection on charges, payments, package sessions, goods receipts, and
 * supplier invoices — a real, direct financial/inventory-safety regression
 * from enabling RLS, caught by this project's own existing tests, not
 * theoretical). `error.meta.modelName` is present on every P2002 regardless
 * of driver adapter or RLS state (verified the same way) and needs no
 * introspection of the constraint's own shape at all — strictly more
 * robust, not merely a workaround.
 */
export function isIdempotencyKeyConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && error.meta?.modelName === "IdempotencyKey"
}
