"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { ReasonDialog } from "@/app/(dashboard)/invoices/[id]/reason-dialog"
import { authorizeRefundAction, rejectRefundAction, completeRefundAction } from "@/app/(dashboard)/invoices/actions"

export function RefundActions({
  invoiceId,
  refundId,
  status,
  cashierSessionId,
}: {
  invoiceId: string
  refundId: string
  status: string
  cashierSessionId?: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  if (status === "requested") {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                setError(null)
                const result = await authorizeRefundAction(invoiceId, refundId)
                if (result.error) setError(result.error)
                else router.refresh()
              })
            }
          >
            Authorize
          </Button>
          <ReasonDialog
            triggerLabel="Reject"
            title="Reject refund"
            variant="destructive"
            action={rejectRefundAction}
            args={[invoiceId, refundId]}
          />
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    )
  }

  if (status === "authorized") {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null)
              const result = await completeRefundAction(invoiceId, refundId, cashierSessionId)
              if (result.error) setError(result.error)
              else router.refresh()
            })
          }
        >
          Complete
        </Button>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    )
  }

  return null
}
