import "server-only"
import { db } from "@/lib/db"
import { getSetting } from "@/lib/platform/settings"
import { writeAuditLog } from "@/lib/platform/audit"
import { MODULE_KEYS, MODULE_LABELS, isRouteEnforceable, type ModuleKey } from "@/lib/platform/entitlements-shared"

/**
 * P5.1: server-only half of the module-entitlement system (DB reads/writes,
 * audit). Constants and pure functions (MODULE_KEYS, MODULE_LABELS,
 * ModuleKey, isRouteEnforceable) live in entitlements-shared.ts and are
 * re-exported below so existing server-side imports of this file keep
 * working unchanged — see that file's own doc comment for why the split
 * exists (a client-bundling failure, not just tidiness).
 */
export { MODULE_KEYS, MODULE_LABELS, isRouteEnforceable, type ModuleKey } from "@/lib/platform/entitlements-shared"

function settingKeyFor(moduleKey: ModuleKey): string {
  // §29/extend-not-replace: "pharmacy" reuses the EXACT pre-existing
  // `pharmacy_enabled` setting key (settings.ts, P4.6) rather than forking a
  // second, parallel flag for the same concept — a clinic that already
  // toggled pharmacy off keeps that exact state under the new, general
  // entitlement system with zero migration/backfill needed.
  if (moduleKey === "pharmacy") return "pharmacy_enabled"
  return `module_enabled:${moduleKey}`
}

/** True unless a row explicitly disables this module — matches the existing `isPharmacyEnabled` default-on convention (P4.6). */
export async function isModuleEnabled(organizationId: string, moduleKey: ModuleKey): Promise<boolean> {
  return getSetting(organizationId, settingKeyFor(moduleKey), true)
}

export async function getModuleEntitlements(organizationId: string): Promise<Record<ModuleKey, boolean>> {
  const entries = await Promise.all(MODULE_KEYS.map(async (key) => [key, await isModuleEnabled(organizationId, key)] as const))
  return Object.fromEntries(entries) as Record<ModuleKey, boolean>
}

/**
 * P5.1 §15/§39: the one writer of module-entitlement state — called only
 * from the platform organization-detail action and from provisioning
 * (never from a clinic-facing route; §14/§66 "tenant cannot alter its own
 * commercial entitlement"). Writes straight to `Setting` (bypassing
 * settings.ts's own `setSetting`, which expects a clinic `SessionContext`
 * and checks `settings.edit` — a platform operator has neither) and audits
 * via the same `writeAuditLog` every other domain mutation uses, scoped to
 * the organization being changed with the operator's own id as the actor
 * (§39/§40 — no secrets, no PHI, just the before/after module+enabled pair).
 */
export async function setModuleEntitlement(input: {
  organizationId: string
  moduleKey: ModuleKey
  enabled: boolean
  operatorId: string
}): Promise<void> {
  const key = settingKeyFor(input.moduleKey)
  const before = await getSetting<boolean | null>(input.organizationId, key, null)
  const existing = await db.setting.findFirst({ where: { organizationId: input.organizationId, branchId: null, key } })
  if (existing) {
    await db.setting.update({ where: { id: existing.id }, data: { value: input.enabled } })
  } else {
    await db.setting.create({ data: { organizationId: input.organizationId, branchId: null, key, value: input.enabled } })
  }
  await writeAuditLog({
    organizationId: input.organizationId,
    userId: input.operatorId,
    action: "platform.module_entitlement.update",
    entityType: "module_entitlement",
    entityId: input.moduleKey,
    oldValues: { enabled: before },
    newValues: { enabled: input.enabled },
  })
}

/** Seeds every module's entitlement explicitly from a plan's defaults at provisioning time (§29) — every key gets a real, auditable row, never an implicit default. */
export async function seedModuleEntitlementsFromPlan(input: { organizationId: string; defaultModuleKeys: string[]; operatorId: string }): Promise<void> {
  const enabledSet = new Set(input.defaultModuleKeys)
  for (const moduleKey of MODULE_KEYS) {
    await setModuleEntitlement({
      organizationId: input.organizationId,
      moduleKey,
      enabled: enabledSet.has(moduleKey),
      operatorId: input.operatorId,
    })
  }
}

/**
 * P5.2 — Server Action entitlement audit (P5.1's own carry-forward item):
 * `proxy.ts` only gates a disabled module's PAGE navigation, never the
 * Server Action endpoint itself — a Server Action bound to a disabled
 * module's UI could previously still be invoked directly (stale client
 * bundle, replayed form post, direct fetch to the action endpoint) and
 * succeed as long as the caller held the RBAC permission, regardless of
 * commercial entitlement state. This is the mutation-path chokepoint every
 * gated module's `actions.ts` now calls from its own local
 * `requireSession()` helper — one call site per file, since every action in
 * a given file belongs to exactly one module.
 *
 * Deliberately mirrors `proxy.ts`'s own `isRouteEnforceable` carve-out: the
 * core clinical spine (reception/patients/appointments/clinical/nursing) is
 * never blocked here either, for the identical clinical-safety reason — see
 * `entitlements-shared.ts`'s own doc comment. None of the 18 currently
 * gated `actions.ts` files are core-spine modules, so this is a no-op today,
 * but keeps this helper safe to reuse if that ever changes.
 *
 * Read paths are deliberately NOT gated here (or anywhere) — P5.1 already
 * guarantees a disabled module's historical data stays readable; disabling
 * a module hides it from navigation and blocks *new* mutations, never
 * existing data.
 */
export class ModuleDisabledError extends Error {
  constructor(moduleKey: ModuleKey) {
    super(`The ${MODULE_LABELS[moduleKey]} module is not enabled for this organization. Contact your platform operator to enable it.`)
    this.name = "ModuleDisabledError"
  }
}

export async function assertModuleEnabled(organizationId: string, moduleKey: ModuleKey): Promise<void> {
  if (!isRouteEnforceable(moduleKey)) return
  const enabled = await isModuleEnabled(organizationId, moduleKey)
  if (!enabled) throw new ModuleDisabledError(moduleKey)
}
