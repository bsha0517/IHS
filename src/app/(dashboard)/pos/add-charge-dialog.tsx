"use client"

import { useState } from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { createAdHocChargeAction, type ActionState } from "@/app/(dashboard)/pos/actions"

const initialState: ActionState = {}

const SOURCE_TYPES = ["procedure", "product", "package", "other"] as const

export function AddChargeDialog({
  patientId,
  branchId,
  services,
  products,
  providers,
}: {
  patientId: string
  branchId: string
  services: { id: string; name: string; price: number }[]
  products: { id: string; name: string; price: number; unit: string }[]
  providers: { id: string; firstName: string; lastName: string }[]
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(createAdHocChargeAction, initialState)
  const [serviceId, setServiceId] = useState<string>("")
  const [productId, setProductId] = useState<string>("")
  const [description, setDescription] = useState("")
  const [unitPrice, setUnitPrice] = useState<string>("")
  // P3.7 §45: one key per dialog-open, resubmitted unchanged by every retry
  // of that attempt — the same "createAdHocCharge previously had no
  // duplicate-submission guard" fix as recordPayment's own idempotencyKey.
  // See createAdHocCharge (billing/charges.ts) for what the server does
  // with it.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())

  function handleSubmit(formData: FormData) {
    formData.set("idempotencyKey", idempotencyKey)
    submit(formData)
  }

  function onServiceChange(value: string) {
    setServiceId(value)
    setProductId("")
    const service = services.find((s) => s.id === value)
    if (service) {
      setDescription(service.name)
      setUnitPrice(String(service.price))
    }
  }

  function onProductChange(value: string) {
    setProductId(value)
    setServiceId("")
    const product = products.find((p) => p.id === value)
    if (product) {
      setDescription(product.name)
      setUnitPrice(String(product.price))
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) setIdempotencyKey(crypto.randomUUID())
        setOpen(o)
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus /> Add charge
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add charge</DialogTitle>
        </DialogHeader>
        <form action={handleSubmit} className="grid gap-4">
          <input type="hidden" name="patientId" value={patientId} />
          <input type="hidden" name="branchId" value={branchId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="sourceType">Source</Label>
            <Select name="sourceType" defaultValue="other">
              <SelectTrigger id="sourceType" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOURCE_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="serviceId">From service catalog (optional)</Label>
            <Select name="serviceId" value={serviceId} onValueChange={onServiceChange}>
              <SelectTrigger id="serviceId" className="w-full">
                <SelectValue placeholder="None — enter manually below" />
              </SelectTrigger>
              <SelectContent>
                {services.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name} — {s.price.toFixed(2)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="productId">From product catalog (optional — sells real stock, FEFO-allocated)</Label>
            <Select name="productId" value={productId} onValueChange={onProductChange}>
              <SelectTrigger id="productId" className="w-full">
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                {products.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} — {p.price.toFixed(2)} / {p.unit}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="description">Description</Label>
            <Input
              id="description"
              name="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="providerId">Provider (optional — for commission attribution)</Label>
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
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="quantity">Quantity</Label>
              <Input id="quantity" name="quantity" type="number" min="1" defaultValue="1" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="unitPrice">Unit price</Label>
              <Input
                id="unitPrice"
                name="unitPrice"
                type="number"
                step="0.01"
                min="0"
                value={unitPrice}
                onChange={(e) => setUnitPrice(e.target.value)}
                required
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Adding..." : "Add charge"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
