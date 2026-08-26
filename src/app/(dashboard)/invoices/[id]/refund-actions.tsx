"use client"

import { useTransition } from "react"
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

  if (status === "requested") {
    return (
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              await authorizeRefundAction(invoiceId, refundId)
              router.refresh()
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
    )
  }

  if (status === "authorized") {
    return (
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            await completeRefundAction(invoiceId, refundId, cashierSessionId)
            router.refresh()
          })
        }
      >
        Complete
      </Button>
    )
  }

  return null
}
