"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { CheckCheck, PackageCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { verifyDispensingRecordAction, dispenseRecordAction } from "@/app/(dashboard)/pharmacy/actions"

export function VerifyButton({ dispensingRecordId, prescriptionId }: { dispensingRecordId: string; prescriptionId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null)
            const result = await verifyDispensingRecordAction(dispensingRecordId, prescriptionId)
            if (result.error) setError(result.error)
            else router.refresh()
          })
        }
      >
        <CheckCheck className="size-3.5" /> Verify
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

export function DispenseButton({ dispensingRecordId, prescriptionId }: { dispensingRecordId: string; prescriptionId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null)
            const result = await dispenseRecordAction(dispensingRecordId, prescriptionId)
            if (result.error) setError(result.error)
            else router.refresh()
          })
        }
      >
        <PackageCheck className="size-3.5" /> Dispense
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
