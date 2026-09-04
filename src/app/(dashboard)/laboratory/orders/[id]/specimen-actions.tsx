"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { ReasonDialog } from "@/app/(dashboard)/invoices/[id]/reason-dialog"
import { collectSpecimenAction, receiveSpecimenAction, rejectSpecimenAction } from "@/app/(dashboard)/laboratory/actions"

export function CollectButton({ specimenId, clinicalOrderId }: { specimenId: string; clinicalOrderId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  // P3.5 §34: these void actions previously had no error handling at all —
  // a rejected call (e.g. this batch's own new branch-access check, or a
  // stale specimen state) became an unhandled promise rejection, surfacing
  // only the generic route-level error boundary instead of the specific
  // message the domain layer already throws. Same fix P3.3 applied to
  // EncounterHeader's own void actions.
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        disabled={pending}
        onClick={() => {
          setError(null)
          startTransition(async () => {
            try {
              await collectSpecimenAction(specimenId, clinicalOrderId)
              router.refresh()
            } catch (e) {
              setError(e instanceof Error ? e.message : "Couldn't mark this specimen collected.")
            }
          })
        }}
      >
        Mark collected
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

export function ReceiveButton({ specimenId, clinicalOrderId }: { specimenId: string; clinicalOrderId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => {
          setError(null)
          startTransition(async () => {
            try {
              await receiveSpecimenAction(specimenId, clinicalOrderId)
              router.refresh()
            } catch (e) {
              setError(e instanceof Error ? e.message : "Couldn't mark this specimen received.")
            }
          })
        }}
      >
        Mark received
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
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
