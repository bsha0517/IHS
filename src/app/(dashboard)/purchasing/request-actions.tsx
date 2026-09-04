"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { ReasonDialog } from "@/app/(dashboard)/invoices/[id]/reason-dialog"
import { approvePurchaseRequestAction, rejectPurchaseRequestAction } from "@/app/(dashboard)/purchasing/actions"

export function RequestActions({ requestId }: { requestId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null)
              const result = await approvePurchaseRequestAction(requestId)
              if (result.error) {
                setError(result.error)
                return
              }
              router.refresh()
            })
          }
        >
          Approve
        </Button>
        <ReasonDialog
          triggerLabel="Reject"
          title="Reject purchase request"
          variant="destructive"
          action={rejectPurchaseRequestAction}
          args={[requestId]}
        />
      </div>
      {error && <p className="max-w-xs text-right text-xs text-destructive">{error}</p>}
    </div>
  )
}
