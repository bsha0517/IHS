"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { CheckCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { markPerformedAction, verifyImagingResultAction } from "@/app/(dashboard)/radiology/actions"

export function MarkPerformedButton({ imagingOrderId, clinicalOrderId }: { imagingOrderId: string; clinicalOrderId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  // P3.5 §34: these void actions previously had no error handling — a
  // rejected call (this batch's own new branch-access check, or a stale
  // status) became an unhandled promise rejection, surfacing only the
  // generic route-level error boundary. Same fix P3.3 applied to
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
              await markPerformedAction(imagingOrderId, clinicalOrderId)
              router.refresh()
            } catch (e) {
              setError(e instanceof Error ? e.message : "Couldn't mark this study performed.")
            }
          })
        }}
      >
        Mark performed
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

export function VerifyButton({ imagingOrderId, clinicalOrderId }: { imagingOrderId: string; clinicalOrderId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
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
              await verifyImagingResultAction(imagingOrderId, clinicalOrderId)
              router.refresh()
            } catch (e) {
              setError(e instanceof Error ? e.message : "Couldn't verify this report.")
            }
          })
        }}
      >
        <CheckCheck className="size-3.5" /> Verify
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
