import "server-only"

/**
 * P1 §20: "Create centralized transition validation." Generalizes the
 * pattern appointments/service.ts's own `transition()` helper already
 * proved out for Appointment (allowedFrom array + throw on violation) so
 * every other status-driven model (ClinicalOrder, LabOrderTest, ...) uses
 * the identical discipline instead of each status-changing function
 * inventing (or, as found this batch, omitting) its own inline check.
 *
 * A transition map is a plain `{ [fromStatus]: toStatus[] }` object defined
 * once per model, next to that model's own service functions — not a
 * generic engine, just a single shared guard every one of those maps is
 * checked through. A status with no listed transitions (an empty array) is
 * terminal: nothing may move away from it through this guard — corrections
 * to a terminal record go through an amendment/new-version path instead
 * (P1 §21/§23), never a status transition.
 *
 * Self-transitions (`from === to`) are NOT implicitly allowed — a map that
 * wants "re-enter while still in this state" (e.g. correcting a lab result
 * before it's verified) must list that status as its own allowed target
 * explicitly, so every transition a caller can make is visible in one
 * place, not split between the map and this function's own special-casing.
 */
export function assertValidTransition<S extends string>(
  transitions: Readonly<Record<S, readonly S[]>>,
  from: S,
  to: S,
  label: string
): void {
  const allowed = transitions[from] ?? []
  if (!allowed.includes(to)) {
    throw new Error(`Cannot move ${label} from "${from}" to "${to}".`)
  }
}
