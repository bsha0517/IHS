"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { ReasonDialog } from "@/app/(dashboard)/invoices/[id]/reason-dialog"
import { approvePurchaseRequestAction, rejectPurchaseRequestAction } from "@/app/(dashboard)/purchasing/actions"

export function RequestActions({ requestId }: { requestId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <div className="flex gap-2">
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            await approvePurchaseRequestAction(requestId)
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
  )
}
