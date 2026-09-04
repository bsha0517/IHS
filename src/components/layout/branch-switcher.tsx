"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Building2 } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { switchBranchAction } from "@/app/(dashboard)/actions"

/**
 * P3.12 §18-21: the global branch switcher, resolving the P3.1 backlog item
 * ("no global branch switcher"). Only rendered when the session has more
 * than one switchable branch (see layout.tsx) — a single-branch user never
 * sees this at all, same discipline as the Inventory page's own per-page
 * BranchSelector. This is a navigation preference, never authorization:
 * switching only changes which branch operational pages default to: every
 * domain write/read still independently enforces its own branch scoping.
 */
export function BranchSwitcher({
  branches,
  activeBranchId,
}: {
  branches: { id: string; name: string }[]
  activeBranchId: string | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <Building2 className="size-4 shrink-0" />
      <Select
        value={activeBranchId ?? undefined}
        disabled={pending}
        onValueChange={(branchId) => {
          startTransition(async () => {
            const formData = new FormData()
            formData.set("branchId", branchId)
            const result = await switchBranchAction({}, formData)
            if (result.error) {
              toast.error(result.error)
            } else {
              router.refresh()
            }
          })
        }}
      >
        <SelectTrigger className="h-8 w-[180px] border-none bg-transparent shadow-none">
          <SelectValue placeholder="Select branch" />
        </SelectTrigger>
        <SelectContent>
          {branches.map((b) => (
            <SelectItem key={b.id} value={b.id}>
              {b.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
