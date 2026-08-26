"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { CheckCheck, PackageCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { verifyDispensingRecordAction, dispenseRecordAction } from "@/app/(dashboard)/pharmacy/actions"

export function VerifyButton({ dispensingRecordId, prescriptionId }: { dispensingRecordId: string; prescriptionId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await verifyDispensingRecordAction(dispensingRecordId, prescriptionId)
          router.refresh()
        })
      }
    >
      <CheckCheck className="size-3.5" /> Verify
    </Button>
  )
}

export function DispenseButton({ dispensingRecordId, prescriptionId }: { dispensingRecordId: string; prescriptionId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await dispenseRecordAction(dispensingRecordId, prescriptionId)
          router.refresh()
        })
      }
    >
      <PackageCheck className="size-3.5" /> Dispense
    </Button>
  )
}
