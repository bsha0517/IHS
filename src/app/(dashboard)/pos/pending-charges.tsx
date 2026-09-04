"use client"

import { useMemo, useState, useTransition } from "react"
import { useActionState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { EmptyState } from "@/components/ui/empty-state"
import { AddChargeDialog } from "@/app/(dashboard)/pos/add-charge-dialog"
import { generateInvoiceAction, voidChargeAction, type ActionState } from "@/app/(dashboard)/pos/actions"

const initialState: ActionState = {}

// P3.7 §11: readable labels for the raw `sourceType` enum — a cashier
// shouldn't need to know what "imaging"/"product" mean internally.
const SOURCE_TYPE_LABEL: Record<string, string> = {
  consultation: "Consultation",
  procedure: "Procedure",
  lab: "Laboratory",
  imaging: "Radiology",
  pharmacy: "Pharmacy",
  product: "POS product",
  package: "Package",
  other: "Other",
}

type ChargeRow = {
  id: string
  description: string
  sourceType: string
  quantity: number
  unitPrice: number
  amount: number
}

export function PendingCharges({
  patientId,
  branchId,
  charges,
  services,
  products,
  providers,
  coverages,
  canVoid,
  canDiscount,
}: {
  patientId: string
  branchId: string
  charges: ChargeRow[]
  services: { id: string; name: string; price: number }[]
  products: { id: string; name: string; price: number; unit: string }[]
  providers: { id: string; firstName: string; lastName: string }[]
  coverages: { id: string; label: string }[]
  canVoid: boolean
  /** P3.7 §37: neither Cashier nor Receptionist holds `invoice.discount` in
   * the seeded roles — showing the field to a session that can't actually
   * use it (generateInvoice rejects server-side the moment discountAmount >
   * 0) just invites a confusing rejection. Hidden entirely rather than
   * shown-then-blocked. */
  canDiscount: boolean
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [discount, setDiscount] = useState(0)
  const [state, formAction, pending] = useActionState(generateInvoiceAction, initialState)
  const [voiding, startVoidTransition] = useTransition()
  const [voidError, setVoidError] = useState<string | null>(null)

  const selectedTotal = useMemo(
    () => charges.filter((c) => selected.has(c.id)).reduce((sum, c) => sum + c.amount, 0),
    [charges, selected]
  )

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Pending charges</CardTitle>
        <AddChargeDialog patientId={patientId} branchId={branchId} services={services} products={products} providers={providers} />
      </CardHeader>
      <CardContent className="grid gap-4">
        {charges.length === 0 && <EmptyState title="No pending charges" description="This patient has no pending charges." className="border-none py-6" />}
        {voidError && (
          <Alert variant="destructive">
            <AlertDescription>{voidError}</AlertDescription>
          </Alert>
        )}

        {charges.length > 0 && (
          <form action={formAction} className="grid gap-4">
            <input type="hidden" name="patientId" value={patientId} />
            <input type="hidden" name="branchId" value={branchId} />
            {state.error && (
              <Alert variant="destructive">
                <AlertDescription>{state.error}</AlertDescription>
              </Alert>
            )}
            <div className="grid gap-2">
              {charges.map((charge) => (
                <label
                  key={charge.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border p-2 text-sm"
                >
                  <span className="flex items-center gap-2">
                    <Checkbox
                      name="chargeIds"
                      value={charge.id}
                      checked={selected.has(charge.id)}
                      onCheckedChange={() => toggle(charge.id)}
                    />
                    <span>
                      {charge.description}
                      <span className="ml-2 text-xs text-muted-foreground">({SOURCE_TYPE_LABEL[charge.sourceType] ?? charge.sourceType})</span>
                    </span>
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="text-right tabular-nums">
                      <span className="text-muted-foreground">
                        {charge.quantity} × {charge.unitPrice.toFixed(2)} ={" "}
                      </span>
                      <span className="font-medium">{charge.amount.toFixed(2)}</span>
                    </span>
                    {canVoid && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        disabled={voiding}
                        onClick={() =>
                          startVoidTransition(async () => {
                            setVoidError(null)
                            const result = await voidChargeAction(charge.id, "Voided at POS")
                            if (result.error) setVoidError(result.error)
                            else router.refresh()
                          })
                        }
                      >
                        Void
                      </Button>
                    )}
                  </span>
                </label>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="grid gap-1.5">
                <Label htmlFor="providerId" className="text-xs">
                  Provider (optional)
                </Label>
                <Select name="providerId">
                  <SelectTrigger id="providerId" className="w-full">
                    <SelectValue placeholder="None" />
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
              {coverages.length > 0 && (
                <div className="grid gap-1.5">
                  <Label htmlFor="patientCoverageId" className="text-xs">
                    Bill to insurance (optional)
                  </Label>
                  <Select name="patientCoverageId">
                    <SelectTrigger id="patientCoverageId" className="w-full">
                      <SelectValue placeholder="Self-pay" />
                    </SelectTrigger>
                    <SelectContent>
                      {coverages.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {canDiscount && (
                <div className="grid gap-1.5">
                  <Label htmlFor="discountAmount" className="text-xs">
                    Discount
                  </Label>
                  <Input
                    id="discountAmount"
                    name="discountAmount"
                    type="number"
                    step="0.01"
                    min="0"
                    defaultValue="0"
                    onChange={(e) => setDiscount(Number(e.target.value) || 0)}
                  />
                </div>
              )}
              <div className="grid gap-1.5 text-right">
                <Label className="text-xs">Selected total</Label>
                <p className="pt-1 text-xl font-semibold tabular-nums tracking-tight">
                  {Math.max(0, selectedTotal - discount).toFixed(2)}
                </p>
              </div>
            </div>

            <div>
              <Button type="submit" disabled={pending || selected.size === 0}>
                {pending ? "Creating invoice..." : `Create Invoice (${selected.size})`}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  )
}
