/**
 * P5.1: client-safe half of the module-entitlement system — constants and
 * pure functions only, no "server-only", no db.ts import. Split out of
 * entitlements.ts because that file imports db.ts (Prisma + the pg driver
 * adapter), and several client components ("use client") need MODULE_KEYS/
 * MODULE_LABELS purely for rendering a checkbox list — importing them from
 * the server-only file pulled the whole db.ts → pg dependency chain into
 * the browser bundle, which fails to resolve pg's Node built-ins (net/tls)
 * there. Server code should still prefer importing from entitlements.ts
 * (which re-exports everything here) unless it specifically needs to stay
 * bundle-safe for a client component.
 *
 * NOTE — a differently-scoped `ModuleKey` also exists in
 * `components/layout/module-visual.ts` (P4.10's page-header icon/accent
 * config: includes non-gateable entries like "admin"/"notifications"/
 * "platform" and uses "billing" instead of "pos_billing"). The two are
 * intentionally separate types for separate concerns (visual identity vs.
 * commercial entitlement) — import from whichever file matches what you're
 * actually doing, never both under the same local name in one file.
 */

/**
 * P5.1 §13/§14/§15: the fixed set of gateable modules. A plain const array,
 * not a Prisma enum — the same choice this codebase already made for
 * `NumberSequence.sequenceType` (an extensible-but-bounded set is cheaper to
 * grow as a validated string than to migrate an enum for). "Admin" is
 * deliberately absent (§13: never a paid module).
 *
 * §16: `patients`, `appointments`, `reception`, `clinical`, `nursing` are
 * included so a plan can still *represent* them, but — see `CORE_MODULES`
 * below and `isRouteEnforceable` — they are never actually blocked at the
 * route boundary. Disabling one of them only removes it from the sidebar;
 * historical clinical data stays reachable and no clinically-dangerous 404
 * is ever introduced by an entitlement change. That's a deliberate,
 * documented P5.1 scope boundary (§16's own "if full enforcement cannot
 * safely be implemented now, implement plan configuration +
 * navigation/readiness gating first"), not an oversight — see
 * P5_1_COMMERCIAL_SAAS_FOUNDATION_REPORT.md.
 */
export const MODULE_KEYS = [
  "reception",
  "patients",
  "appointments",
  "clinical",
  "nursing",
  "laboratory",
  "radiology",
  "pharmacy",
  "pos_billing",
  "inventory",
  "procurement",
  "finance",
  "hr",
  "payroll",
  "assets",
  "reports",
  "imports_onboarding",
] as const

export type ModuleKey = (typeof MODULE_KEYS)[number]

export const MODULE_LABELS: Record<ModuleKey, string> = {
  reception: "Reception",
  patients: "Patient Management",
  appointments: "Appointments",
  clinical: "Clinical / Doctor",
  nursing: "Nursing",
  laboratory: "Laboratory",
  radiology: "Radiology",
  pharmacy: "Pharmacy",
  pos_billing: "POS / Billing",
  inventory: "Inventory",
  procurement: "Procurement",
  finance: "Finance",
  hr: "HR",
  payroll: "Payroll",
  assets: "Assets",
  reports: "Reports",
  imports_onboarding: "Imports / Onboarding",
}

/**
 * §16: modules never blocked at the route boundary regardless of their
 * entitlement flag — the core clinical/operational spine a running clinic
 * cannot safely lose access to mid-operation. See this file's own top
 * comment and §36/§37.14 of the P5.1 report for the full reasoning.
 */
const CORE_MODULES: ReadonlySet<ModuleKey> = new Set(["reception", "patients", "appointments", "clinical", "nursing"])

export function isRouteEnforceable(moduleKey: ModuleKey): boolean {
  return !CORE_MODULES.has(moduleKey)
}
