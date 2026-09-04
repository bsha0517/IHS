"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { markNotificationReadAction } from "@/app/(dashboard)/notifications/actions"

/** Same useTransition + router.refresh() pattern as /admin/system-events's RetryButton. */
export function MarkReadButton({ id }: { id: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label="Mark as read"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await markNotificationReadAction(id)
          router.refresh()
        })
      }
    >
      <Check className="size-3.5" /> Mark read
    </Button>
  )
}
