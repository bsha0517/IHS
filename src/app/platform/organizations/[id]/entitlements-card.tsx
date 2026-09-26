"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { MODULE_KEYS, MODULE_LABELS, isRouteEnforceable, type ModuleKey } from "@/lib/platform/entitlements-shared"
import { updateModuleEntitlementAction, resetEntitlementsToPlanDefaultsAction } from "@/app/platform/organizations/[id]/actions"

/**
 * P5.1 §13/§15/§29: what this clinic's subscription has enabled. Toggling a
 * checkbox here is the ONLY way any of this ever changes — there is no
 * clinic-facing route that can flip its own entitlement (§14/§66).
 *
 * P5.7 Part 9: `planDefaultModuleKeys` (the current plan's own
 * `defaultModuleKeys`, or null when the org has no subscription) is used
 * purely to LABEL each module — "Included by plan" / "Additional (override)"
 * / "Disabled" — never to change what `entitlements` itself reports. Every
 * toggle now requires an explicit confirmation step naming exactly what will
 * change before `updateModuleEntitlementAction` (already fully audited) is
 * called.
 */
export function EntitlementsCard({
  organizationId,
  entitlements,
  planDefaultModuleKeys,
}: {
  organizationId: string
  entitlements: Record<ModuleKey, boolean>
  planDefaultModuleKeys: ModuleKey[] | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [pendingKey, setPendingKey] = useState<ModuleKey | null>(null)
  const [confirmTarget, setConfirmTarget] = useState<{ key: ModuleKey; nextEnabled: boolean } | null>(null)

  function requestToggle(moduleKey: ModuleKey, nextEnabled: boolean) {
    setConfirmTarget({ key: moduleKey, nextEnabled })
  }

  function applyToggle() {
    if (!confirmTarget) return
    const { key, nextEnabled } = confirmTarget
    setConfirmTarget(null)
    setPendingKey(key)
    startTransition(async () => {
      setError(null)
      const result = await updateModuleEntitlementAction(organizationId, key, nextEnabled)
      if (result.error) setError(result.error)
      else router.refresh()
      setPendingKey(null)
    })
  }

  const isPlanDefault = (key: ModuleKey) => planDefaultModuleKeys?.includes(key) ?? false

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Modules</CardTitle>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null)
              const result = await resetEntitlementsToPlanDefaultsAction(organizationId)
              if (result.error) setError(result.error)
              else router.refresh()
            })
          }
        >
          Reset to plan defaults
        </Button>
      </CardHeader>
      <CardContent className="grid gap-2">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {MODULE_KEYS.map((key) => {
            const enabled = entitlements[key]
            const isDefault = isPlanDefault(key)
            return (
              <label key={key} className="flex items-center justify-between gap-2 rounded-md border border-border p-2 text-sm">
                <span className="flex flex-wrap items-center gap-1.5">
                  {MODULE_LABELS[key]}
                  {!isRouteEnforceable(key) && <span className="text-xs text-muted-foreground">(always accessible)</span>}
                  {enabled ? (
                    isDefault ? (
                      <Badge variant="neutral" className="text-[10px]">
                        Included by plan
                      </Badge>
                    ) : (
                      <Badge variant="info" className="text-[10px]">
                        Additional (override)
                      </Badge>
                    )
                  ) : (
                    <Badge variant="warning" className="text-[10px]">
                      {isDefault ? "Disabled (overrides plan)" : "Disabled"}
                    </Badge>
                  )}
                </span>
                <Checkbox
                  checked={enabled}
                  disabled={pending && pendingKey === key}
                  onCheckedChange={(checked) => requestToggle(key, checked === true)}
                />
              </label>
            )
          })}
        </div>
      </CardContent>

      <Dialog open={confirmTarget !== null} onOpenChange={(open) => !open && setConfirmTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Confirm module change</DialogTitle>
          </DialogHeader>
          {confirmTarget && (
            <p className="text-sm text-muted-foreground">
              {confirmTarget.nextEnabled ? (
                <>
                  Enable <span className="font-medium text-foreground">{MODULE_LABELS[confirmTarget.key]}</span> for this organization
                  {!isPlanDefault(confirmTarget.key) ? " as an additional module beyond its current plan's default bundle." : "."}
                </>
              ) : (
                <>
                  Disable <span className="font-medium text-foreground">{MODULE_LABELS[confirmTarget.key]}</span> for this organization
                  {isPlanDefault(confirmTarget.key) ? " — this overrides the current plan's default, which includes this module." : "."}
                </>
              )}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmTarget(null)}>
              Cancel
            </Button>
            <Button onClick={applyToggle}>Confirm</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
