"use client"

import { useState } from "react"
import { useRouter, usePathname } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { notificationTypeLabel } from "@/lib/domains/notifications/labels"

const ALL = "__all__"

/** §38: lightweight filters only (All/Unread + category/type) — no advanced search. Same GET-param pattern as P3.8's LedgerFilters / P3.10's EmployeeFilters. */
export function NotificationFilters({ types, sp }: { types: string[]; sp: Record<string, string | undefined> }) {
  const router = useRouter()
  const pathname = usePathname()
  const [status, setStatus] = useState(sp.status ?? ALL)
  const [type, setType] = useState(sp.type ?? ALL)

  function apply(nextStatus: string, nextType: string) {
    const params = new URLSearchParams()
    if (nextStatus !== ALL) params.set("status", nextStatus)
    if (nextType !== ALL) params.set("type", nextType)
    router.push(`${pathname}?${params.toString()}`)
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex gap-1">
        <Button
          size="sm"
          variant={status === ALL ? "default" : "outline"}
          onClick={() => {
            setStatus(ALL)
            apply(ALL, type)
          }}
        >
          All
        </Button>
        <Button
          size="sm"
          variant={status === "unread" ? "default" : "outline"}
          onClick={() => {
            setStatus("unread")
            apply("unread", type)
          }}
        >
          Unread
        </Button>
      </div>
      {types.length > 0 && (
        <div className="grid gap-1">
          <Label className="text-xs">Category</Label>
          <Select
            value={type}
            onValueChange={(v) => {
              setType(v)
              apply(status, v)
            }}
          >
            <SelectTrigger className="w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All categories</SelectItem>
              {types.map((t) => (
                <SelectItem key={t} value={t}>
                  {notificationTypeLabel(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  )
}
