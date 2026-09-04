"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { retryAccountingExceptionAction } from "@/app/(dashboard)/accounting/actions"

/** Same retry mechanism `/admin/system-events`'s RetryButton uses — see retryAccountingException's own doc comment (exceptions.ts) for why this is a narrowed wrapper, not a second implementation. */
export function ExceptionRetryButton({ eventId }: { eventId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const formData = new FormData()
          formData.set("eventId", eventId)
          const result = await retryAccountingExceptionAction({}, formData)
          if (result.error) {
            toast.error(result.error)
          } else {
            toast.success("Posting re-queued for retry.")
            router.refresh()
          }
        })
      }
    >
      <RotateCcw className="size-3.5" /> {pending ? "Retrying..." : "Retry"}
    </Button>
  )
}
