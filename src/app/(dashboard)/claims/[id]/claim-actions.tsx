"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { Send, RefreshCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { submitClaimAction, resubmitClaimAction } from "@/app/(dashboard)/claims/actions"

export function SubmitButton({ claimId }: { claimId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await submitClaimAction(claimId)
          router.refresh()
        })
      }
    >
      <Send className="size-3.5" /> Submit claim
    </Button>
  )
}

export function ResubmitButton({ claimId }: { claimId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const newClaimId = await resubmitClaimAction(claimId)
          router.push(`/claims/${newClaimId}`)
        })
      }
    >
      <RefreshCcw className="size-3.5" /> Resubmit
    </Button>
  )
}
