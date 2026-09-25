"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { MODULE_KEYS, MODULE_LABELS, isRouteEnforceable, type ModuleKey } from "@/lib/platform/entitlements-shared"
import { updateModuleEntitlementAction, resetEntitlementsToPlanDefaultsAction } from "@/app/platform/organizations/[id]/actions"

/**
 * P5.1 §13/§15/§29: what this clinic's subscription has enabled. Toggling a
 * checkbox here is the ONLY way any of this ever changes — there is no
 * clinic-facing route that can flip its own entitlement (§14/§66).
 */
export function EntitlementsCard({ organizationId, entitlements }: { organizationId: string; entitlements: Record<ModuleKey, boolean> }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [pendingKey, setPendingKey] = useState<ModuleKey | null>(null)

  function toggle(moduleKey: ModuleKey, enabled: boolean) {
    setPendingKey(moduleKey)
    startTransition(async () => {
      setError(null)
      const result = await updateModuleEntitlementAction(organizationId, moduleKey, enabled)
      if (result.error) setError(result.error)
      else router.refresh()
      setPendingKey(null)
    })
  }

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
          {MODULE_KEYS.map((key) => (
            <label key={key} className="flex items-center justify-between gap-2 rounded-md border border-border p-2 text-sm">
              <span className="flex items-center gap-1.5">
                {MODULE_LABELS[key]}
                {!isRouteEnforceable(key) && <span className="text-xs text-muted-foreground">(always accessible)</span>}
              </span>
              <Checkbox
                checked={entitlements[key]}
                disabled={pending && pendingKey === key}
                onCheckedChange={(checked) => toggle(key, checked === true)}
              />
            </label>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
