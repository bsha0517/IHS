"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { sweepAccountingExceptionsAction } from "@/app/(dashboard)/accounting/actions"

/** Same sweep mechanism `/admin/system-events`'s SweepButton triggers (processPendingOutboxEvents) — see sweepAccountingExceptions's own doc comment (exceptions.ts). Organization-wide by design (outbox.ts), not accounting-scoped — it recovers/dispatches every due event, accounting or not; the accounting exceptions list simply refreshes to reflect whatever it resolved. */
export function ExceptionSweepButton() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await sweepAccountingExceptionsAction()
          if (result.error) {
            toast.error(result.error)
          } else {
            toast.success(`Sweep complete — ${result.recovered ?? 0} recovered, ${result.processed ?? 0} processed.`)
            router.refresh()
          }
        })
      }
    >
      <RefreshCw className="size-3.5" /> {pending ? "Sweeping..." : "Sweep now"}
    </Button>
  )
}
