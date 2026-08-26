"use client"

import { useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { createCommissionRuleAction, type ActionState } from "@/app/(dashboard)/commissions/actions"

const initialState: ActionState = {}
const TYPES = ["fixed", "percentage", "tiered"] as const
const BASES = ["gross_invoice", "net_invoice", "collected_revenue"] as const

type Tier = { minAmount: string; maxAmount: string; rate: string }

export function CommissionRuleDialog({
  providers,
  services,
}: {
  providers: { id: string; firstName: string; lastName: string }[]
  services: { id: string; name: string }[]
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(createCommissionRuleAction, initialState)
  const [type, setType] = useState<string>("percentage")
  const [tiers, setTiers] = useState<Tier[]>([{ minAmount: "0", maxAmount: "", rate: "" }])

  function handleSubmit(formData: FormData) {
    if (type === "tiered") {
      formData.set(
        "tiers",
        JSON.stringify(
          tiers
            .filter((t) => t.rate)
            .map((t) => ({ minAmount: Number(t.minAmount) || 0, maxAmount: t.maxAmount ? Number(t.maxAmount) : null, rate: Number(t.rate) }))
        )
      )
    }
    submit(formData)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus /> New commission rule
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New commission rule</DialogTitle>
        </DialogHeader>
        <form action={handleSubmit} className="grid gap-4">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="providerId">Provider (blank = all)</Label>
              <Select name="providerId">
                <SelectTrigger id="providerId" className="w-full">
                  <SelectValue placeholder="All providers" />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.firstName} {p.lastName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="serviceId">Service (blank = all)</Label>
              <Select name="serviceId">
                <SelectTrigger id="serviceId" className="w-full">
                  <SelectValue placeholder="All services" />
                </SelectTrigger>
                <SelectContent>
                  {services.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="type">Type</Label>
              <Select name="type" value={type} onValueChange={setType}>
                <SelectTrigger id="type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="basis">Basis</Label>
              <Select name="basis" defaultValue="collected_revenue" required>
                <SelectTrigger id="basis" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BASES.map((b) => (
                    <SelectItem key={b} value={b}>
                      {b.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {type === "fixed" && (
            <div className="grid gap-2">
              <Label htmlFor="fixedAmount">Fixed amount</Label>
              <Input id="fixedAmount" name="fixedAmount" type="number" min="0" step="0.01" required />
            </div>
          )}
          {type === "percentage" && (
            <div className="grid gap-2">
              <Label htmlFor="percentageRate">Percentage rate (0–1, e.g. 0.10 = 10%)</Label>
              <Input id="percentageRate" name="percentageRate" type="number" min="0" max="1" step="0.01" required />
            </div>
          )}
          {type === "tiered" && (
            <div className="grid gap-2">
              <Label className="text-xs">Tiers</Label>
              {tiers.map((t, i) => (
                <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2">
                  <Input placeholder="Min" type="number" value={t.minAmount} onChange={(e) => setTiers((p) => p.map((x, j) => (j === i ? { ...x, minAmount: e.target.value } : x)))} />
                  <Input placeholder="Max (blank = ∞)" type="number" value={t.maxAmount} onChange={(e) => setTiers((p) => p.map((x, j) => (j === i ? { ...x, maxAmount: e.target.value } : x)))} />
                  <Input placeholder="Rate" type="number" step="0.01" value={t.rate} onChange={(e) => setTiers((p) => p.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)))} />
                  {tiers.length > 1 && (
                    <Button type="button" size="icon-sm" variant="ghost" onClick={() => setTiers((p) => p.filter((_, j) => j !== i))}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={() => setTiers((p) => [...p, { minAmount: "", maxAmount: "", rate: "" }])}>
                <Plus /> Add tier
              </Button>
            </div>
          )}

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Create rule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
