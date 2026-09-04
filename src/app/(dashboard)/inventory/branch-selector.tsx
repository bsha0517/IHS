"use client"

import { useRouter, useSearchParams, usePathname } from "next/navigation"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

/**
 * P3.8 §17: lets a multi-branch-authorized user pick which branch the Stock
 * tab's Adjust-stock action targets — server-side `recordAdjustment` already
 * accepts and authorizes any session-accessible branch (`assertCan(...,
 * {branchId})`), this was purely a missing UI selector. Only ever rendered
 * for users with more than one accessible branch (see page.tsx) — a
 * single-branch user never sees this at all.
 */
export function BranchSelector({ branches, activeBranchId }: { branches: { id: string; name: string }[]; activeBranchId: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  function handleChange(branchId: string) {
    const params = new URLSearchParams(searchParams.toString())
    params.set("activeBranchId", branchId)
    router.push(`${pathname}?${params.toString()}`)
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">Adjusting stock at</span>
      <Select value={activeBranchId} onValueChange={handleChange}>
        <SelectTrigger className="w-[200px]">
          <SelectValue />
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
