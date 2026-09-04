"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { toggleBranchStatusAction, toggleDepartmentStatusAction } from "@/app/(dashboard)/admin/settings/actions"

type Status = "active" | "inactive"

/** Shared by Branch and Department status toggles (P3.12 §9/§38) — same shape as admin/users/status-toggle.tsx, generalized over which action to call. */
function useStatusToggle(action: (id: string, status: Status) => Promise<void>, id: string, status: Status) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const nextStatus: Status = status === "active" ? "inactive" : "active"

  function toggle() {
    startTransition(async () => {
      try {
        await action(id, nextStatus)
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to update status.")
      }
    })
  }

  return { pending, nextStatus, toggle }
}

export function BranchStatusToggle({ branchId, status }: { branchId: string; status: Status }) {
  const { pending, nextStatus, toggle } = useStatusToggle(toggleBranchStatusAction, branchId, status)
  return (
    <Button size="sm" variant="ghost" disabled={pending} onClick={toggle}>
      {pending ? "Saving..." : nextStatus === "inactive" ? "Deactivate" : "Activate"}
    </Button>
  )
}

export function DepartmentStatusToggle({ departmentId, status }: { departmentId: string; status: Status }) {
  const { pending, nextStatus, toggle } = useStatusToggle(toggleDepartmentStatusAction, departmentId, status)
  return (
    <Button size="sm" variant="ghost" disabled={pending} onClick={toggle}>
      {pending ? "Saving..." : nextStatus === "inactive" ? "Deactivate" : "Activate"}
    </Button>
  )
}
