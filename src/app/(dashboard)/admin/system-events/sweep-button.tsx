"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { sweepSystemEventsAction } from "@/app/(dashboard)/admin/system-events/actions"

/** P1 §4's admin/manual trigger for processPendingOutboxEvents() — recovers stuck events, then dispatches due ones, across the organization. */
export function SweepButton() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await sweepSystemEventsAction()
          if (result.error) {
            toast.error(result.error)
          } else {
            toast.success(`Sweep complete — ${result.recovered} recovered, ${result.processed} processed.`)
            router.refresh()
          }
        })
      }
    >
      <RefreshCw className="size-3.5" /> {pending ? "Sweeping..." : "Sweep now"}
    </Button>
  )
}
