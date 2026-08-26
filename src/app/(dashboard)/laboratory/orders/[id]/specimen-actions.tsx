"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { ReasonDialog } from "@/app/(dashboard)/invoices/[id]/reason-dialog"
import { collectSpecimenAction, receiveSpecimenAction, rejectSpecimenAction } from "@/app/(dashboard)/laboratory/actions"

export function CollectButton({ specimenId, clinicalOrderId }: { specimenId: string; clinicalOrderId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await collectSpecimenAction(specimenId, clinicalOrderId)
          router.refresh()
        })
      }
    >
      Mark collected
    </Button>
  )
}

export function ReceiveButton({ specimenId, clinicalOrderId }: { specimenId: string; clinicalOrderId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await receiveSpecimenAction(specimenId, clinicalOrderId)
          router.refresh()
        })
      }
    >
      Mark received
    </Button>
  )
}

export function RejectSpecimenButton({ specimenId, clinicalOrderId }: { specimenId: string; clinicalOrderId: string }) {
  return (
    <ReasonDialog
      triggerLabel="Reject"
      title="Reject specimen"
      variant="destructive"
      action={rejectSpecimenAction}
      args={[specimenId, clinicalOrderId] as [string, string]}
    />
  )
}
