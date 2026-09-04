"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { completeTransferAction, cancelTransferAction } from "@/app/(dashboard)/inventory/actions"

export function TransferRowActions({ transferId }: { transferId: string }) {
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
              const result = await completeTransferAction(transferId)
              if (result.error) {
                setError(result.error)
                return
              }
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
              setError(null)
              const result = await cancelTransferAction(transferId, "Cancelled by staff")
              if (result.error) {
                setError(result.error)
                return
              }
              router.refresh()
            })
          }
        >
          Cancel
        </Button>
      </div>
      {error && <p className="max-w-xs text-right text-xs text-destructive">{error}</p>}
    </div>
  )
}
