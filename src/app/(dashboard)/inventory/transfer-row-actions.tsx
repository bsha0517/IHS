"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { completeTransferAction, cancelTransferAction } from "@/app/(dashboard)/inventory/actions"

export function TransferRowActions({ transferId }: { transferId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <div className="flex gap-2">
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            await completeTransferAction(transferId)
            router.refresh()
          })
        }
      >
        Complete
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            await cancelTransferAction(transferId, "Cancelled by staff")
            router.refresh()
          })
        }
      >
        Cancel
      </Button>
    </div>
  )
}
