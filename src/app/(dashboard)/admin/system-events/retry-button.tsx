"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { retrySystemEventAction } from "@/app/(dashboard)/admin/system-events/actions"

export function RetryButton({ eventId }: { eventId: string }) {
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
          const result = await retrySystemEventAction({}, formData)
          if (result.error) {
            toast.error(result.error)
          } else {
            toast.success("Event re-queued for retry.")
            router.refresh()
          }
        })
      }
    >
      <RotateCcw className="size-3.5" /> {pending ? "Retrying..." : "Retry"}
    </Button>
  )
}
