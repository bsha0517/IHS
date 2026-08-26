"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
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
          await toggleUserStatusAction(userId, nextStatus)
          router.refresh()
        })
      }
    >
      {status === "active" ? "Deactivate" : "Activate"}
    </Button>
  )
}
