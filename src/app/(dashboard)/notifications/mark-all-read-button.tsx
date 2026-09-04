"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { CheckCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { markAllNotificationsReadAction } from "@/app/(dashboard)/notifications/actions"

/** §36: one bulk server update, scoped to the logged-in user's own notifications only (see markAllNotificationsRead's own doc comment). */
export function MarkAllReadButton({ disabled }: { disabled?: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={disabled || pending}
      onClick={() =>
        startTransition(async () => {
          await markAllNotificationsReadAction()
          toast.success("All notifications marked as read.")
          router.refresh()
        })
      }
    >
      <CheckCheck className="size-3.5" /> {pending ? "Marking..." : "Mark all read"}
    </Button>
  )
}
