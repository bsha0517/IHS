"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { toggleUserStatusAction } from "@/app/(dashboard)/admin/users/actions"

export function StatusToggle({ userId, status }: { userId: string; status: "active" | "inactive" | "locked" }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  if (status === "locked") {
    return (
      <span className="text-xs text-muted-foreground">Locked (auto-expires)</span>
    )
  }

  const nextStatus = status === "active" ? "inactive" : "active"

  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          try {
            await toggleUserStatusAction(userId, nextStatus)
            router.refresh()
          } catch (e) {
            // P3.12 §51: this is where the last-admin guard's rejection
            // (updateUser, identity/users.ts) actually surfaces — this
            // action previously had no error handling at all.
            toast.error(e instanceof Error ? e.message : "Failed to update status.")
          }
        })
      }
    >
      {status === "active" ? "Deactivate" : "Activate"}
    </Button>
  )
}
