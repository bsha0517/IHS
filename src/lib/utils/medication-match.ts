/**
 * Targeted backlog closure, item 8 (BACKLOG.md's "No system-enforced
 * cross-check between a prescribed medication and the one a pharmacist
 * selects to dispense"): a deliberately simple, non-clinical heuristic used
 * ONLY to decide whether to show a safety warning before dispensing — never
 * to auto-substitute, never to block a legitimate brand/generic
 * substitution, and never treated as a clinical judgment about
 * equivalence. A normalized case-insensitive equality/substring check, not
 * a fuzzy-matching library — deliberately conservative in what it flags AS
 * a match (so it doesn't nag on a real, obvious substitution like "Panadol"
 * for "Paracetamol 500mg" would still warn, correctly, since neither name
 * appears in the other — the pharmacist's own judgment is what actually
 * resolves that, this is only the trigger for asking them to confirm).
 *
 * Shared between the client dialog (to show the warning immediately) and
 * the server-side domain function (createDispensingRecord, which performs
 * the SAME check so the requirement can't be bypassed by a client that
 * skips the warning).
 */
export function looksLikeSameMedication(prescribedName: string, selectedName: string): boolean {
  const a = normalize(prescribedName)
  const b = normalize(selectedName)
  if (!a || !b) return true // nothing meaningful to compare — never block on missing data
  return a === b || a.includes(b) || b.includes(a)
}

function normalize(name: string): string {
  return name.trim().toLowerCase()
}
