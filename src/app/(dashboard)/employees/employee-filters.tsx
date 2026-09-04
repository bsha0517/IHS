"use client"

import { useState } from "react"
import { useRouter, usePathname } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

const ALL = "__all__"
const STATUSES = ["active", "on_leave", "terminated"] as const

/** P3.10 §7: the Employees page never offered any of the practical filters `listEmployees` already supported (branchId/status) or the free-text search it didn't yet (name/number/designation) — HR had no way to find one employee out of a growing directory except scrolling the paginated list. Same GET-param pattern as P3.8's LedgerFilters. */
export function EmployeeFilters({
  branches,
  departments,
  sp,
}: {
  branches: { id: string; name: string }[]
  departments: { id: string; name: string }[]
  sp: Record<string, string | undefined>
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [q, setQ] = useState(sp.q ?? "")
  const [branchId, setBranchId] = useState(sp.branchId ?? ALL)
  const [departmentId, setDepartmentId] = useState(sp.departmentId ?? ALL)
  const [status, setStatus] = useState(sp.status ?? ALL)

  function apply() {
    const params = new URLSearchParams()
    if (q.trim()) params.set("q", q.trim())
    if (branchId !== ALL) params.set("branchId", branchId)
    if (departmentId !== ALL) params.set("departmentId", departmentId)
    if (status !== ALL) params.set("status", status)
    router.push(`${pathname}?${params.toString()}`)
  }

  function clear() {
    setQ("")
    setBranchId(ALL)
    setDepartmentId(ALL)
    setStatus(ALL)
    router.push(pathname)
  }

  const hasFilters = Boolean(sp.q || sp.branchId || sp.departmentId || sp.status)

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3">
      <div className="grid gap-1">
        <Label className="text-xs">Search</Label>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && apply()}
          placeholder="Name, number, or designation"
          className="w-[220px]"
        />
      </div>
      <div className="grid gap-1">
        <Label className="text-xs">Branch</Label>
        <Select value={branchId} onValueChange={setBranchId}>
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All branches</SelectItem>
            {branches.map((b) => (
              <SelectItem key={b.id} value={b.id}>
                {b.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1">
        <Label className="text-xs">Department</Label>
        <Select value={departmentId} onValueChange={setDepartmentId}>
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All departments</SelectItem>
            {departments.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1">
        <Label className="text-xs">Status</Label>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s.replace("_", " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button size="sm" onClick={apply}>
        Filter
      </Button>
      {hasFilters && (
        <Button size="sm" variant="ghost" onClick={clear}>
          Clear
        </Button>
      )}
    </div>
  )
}
