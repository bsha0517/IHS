"use client"

import { useState } from "react"
import { useRouter, usePathname } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { FilterBar, FilterField } from "@/components/ui/filter-bar"

const TRANSACTION_TYPES = [
  { value: "purchase", label: "Purchase" },
  { value: "sale", label: "Sale" },
  { value: "dispensing", label: "Dispensing" },
  { value: "treatment_consumption", label: "Treatment consumption" },
  { value: "adjustment", label: "Adjustment" },
  { value: "transfer_in", label: "Transfer in" },
  { value: "transfer_out", label: "Transfer out" },
  { value: "damage", label: "Damage" },
  { value: "expiry", label: "Expiry" },
  { value: "return", label: "Return" },
]

const ALL = "__all__"

/** P3.8 §14-15: practical filters on the existing (already-paginated) stock ledger — branch, product, transaction type, date range. No new analytics engine, just WHERE-clause narrowing already supported by listLedgerEntries. */
export function LedgerFilters({
  branches,
  products,
  sp,
}: {
  branches: { id: string; name: string }[]
  products: { id: string; name: string }[]
  sp: Record<string, string | undefined>
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [branchId, setBranchId] = useState(sp.ledgerBranchId ?? ALL)
  const [productId, setProductId] = useState(sp.ledgerProductId ?? ALL)
  const [type, setType] = useState(sp.ledgerType ?? ALL)
  const [from, setFrom] = useState(sp.ledgerFrom ?? "")
  const [to, setTo] = useState(sp.ledgerTo ?? "")

  function apply() {
    const params = new URLSearchParams()
    if (sp.activeBranchId) params.set("activeBranchId", sp.activeBranchId)
    if (branchId !== ALL) params.set("ledgerBranchId", branchId)
    if (productId !== ALL) params.set("ledgerProductId", productId)
    if (type !== ALL) params.set("ledgerType", type)
    if (from) params.set("ledgerFrom", from)
    if (to) params.set("ledgerTo", to)
    router.push(`${pathname}?${params.toString()}`)
  }

  function clear() {
    setBranchId(ALL)
    setProductId(ALL)
    setType(ALL)
    setFrom("")
    setTo("")
    const params = new URLSearchParams()
    if (sp.activeBranchId) params.set("activeBranchId", sp.activeBranchId)
    router.push(`${pathname}?${params.toString()}`)
  }

  const hasFilters = Boolean(sp.ledgerBranchId || sp.ledgerProductId || sp.ledgerType || sp.ledgerFrom || sp.ledgerTo)

  return (
    // P4.7A.1 §32/§33 — the same shared FilterBar shell Reports now uses.
    // Filtering here is client-router-driven (not a native GET submit), so
    // both buttons are explicitly `type="button"` — the only change needed
    // to make a real `<form>` safe to wrap around JS-driven controls; the
    // filtering logic itself (`apply`/`clear`) is untouched.
    <FilterBar onSubmit={(e) => e.preventDefault()}>
      <FilterField label="Branch">
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
      </FilterField>
      <FilterField label="Product">
        <Select value={productId} onValueChange={setProductId}>
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All products</SelectItem>
            {products.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterField>
      <FilterField label="Type">
        <Select value={type} onValueChange={setType}>
          <SelectTrigger className="w-[170px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All types</SelectItem>
            {TRANSACTION_TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterField>
      <FilterField label="From">
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-[150px]" />
      </FilterField>
      <FilterField label="To">
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-[150px]" />
      </FilterField>
      <Button type="button" size="sm" onClick={apply}>
        Filter
      </Button>
      {hasFilters && (
        <Button type="button" size="sm" variant="ghost" onClick={clear}>
          Clear
        </Button>
      )}
    </FilterBar>
  )
}
