"use client"

import { useTransition, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { ReasonDialog } from "@/app/(dashboard)/invoices/[id]/reason-dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { suspendOrganizationAction, reactivateOrganizationAction } from "@/app/platform/organizations/[id]/actions"

/** P5.1 §7/§67: reuses the existing, proven OrgStatus suspend/reactivate enforcement — this is the only place either transition can be triggered from. */
export function LifecycleActions({ organizationId, status }: { organizationId: string; status: "active" | "suspended" }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  if (status === "suspended") {
    return (
      <div className="flex flex-col items-end gap-1">
        {error && (
          <Alert variant="destructive" className="max-w-xs">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null)
              const result = await reactivateOrganizationAction(organizationId)
              if (result.error) setError(result.error)
              else router.refresh()
            })
          }
        >
          Reactivate
        </Button>
      </div>
    )
  }

  return (
    <ReasonDialog
      triggerLabel="Suspend organization"
      title="Suspend this organization"
      variant="destructive"
      action={suspendOrganizationAction}
      args={[organizationId]}
    />
  )
}
