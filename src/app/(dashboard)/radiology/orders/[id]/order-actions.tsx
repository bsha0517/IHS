"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { CheckCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { markPerformedAction, verifyImagingResultAction } from "@/app/(dashboard)/radiology/actions"

export function MarkPerformedButton({ imagingOrderId, clinicalOrderId }: { imagingOrderId: string; clinicalOrderId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await markPerformedAction(imagingOrderId, clinicalOrderId)
          router.refresh()
        })
      }
    >
      Mark performed
    </Button>
  )
}

export function VerifyButton({ imagingOrderId, clinicalOrderId }: { imagingOrderId: string; clinicalOrderId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await verifyImagingResultAction(imagingOrderId, clinicalOrderId)
          router.refresh()
        })
      }
    >
      <CheckCheck className="size-3.5" /> Verify
    </Button>
  )
}
