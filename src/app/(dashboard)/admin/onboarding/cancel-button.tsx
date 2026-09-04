"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { cancelImportAction } from "@/app/(dashboard)/admin/onboarding/actions"

/** P4.6 §41 — cancel is only ever offered before commit starts (the page itself only renders this for `uploaded`/`validated` jobs); once a commit is processing/complete, cancellation is not offered at all rather than pretending it could interrupt safely. */
export function CancelImportButton({ jobId }: { jobId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => {
          setError(null)
          startTransition(async () => {
            try {
              await cancelImportAction(jobId)
              router.refresh()
            } catch (e) {
              setError(e instanceof Error ? e.message : "Couldn't cancel this import.")
            }
          })
        }}
      >
        Cancel
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
