"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { deactivatePatientCoverageAction } from "@/app/(dashboard)/claims/actions"

export function DeactivateCoverageButton({ coverageId, patientId }: { coverageId: string; patientId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await deactivatePatientCoverageAction(coverageId, patientId)
          router.refresh()
        })
      }
    >
      Deactivate
    </Button>
  )
}
