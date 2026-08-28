"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { createOrderAction, cancelOrderAction, type ActionState } from "@/app/(dashboard)/encounters/actions"
import type {
  ClinicalOrder,
  LabOrderDetail,
  ImagingOrderDetail,
  ProcedureOrderDetail,
  ReferralOrderDetail,
  Provider,
} from "@/generated/prisma/client"

const initialState: ActionState = {}

type OrderWithDetails = ClinicalOrder & {
  labDetail: LabOrderDetail | null
  imagingDetail: ImagingOrderDetail | null
  procedureDetail: ProcedureOrderDetail | null
  referralDetail: (ReferralOrderDetail & { referredToProvider: Provider | null }) | null
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  ordered: "outline",
  acknowledged: "secondary",
  in_progress: "secondary",
  completed: "default",
  cancelled: "destructive",
}

function orderLabel(order: OrderWithDetails): string {
  if (order.labDetail) return `Lab: ${order.labDetail.testName}`
  if (order.imagingDetail) return `Imaging: ${order.imagingDetail.imagingType}`
  if (order.procedureDetail) return `Procedure: ${order.procedureDetail.procedureName}`
  if (order.referralDetail) {
    const target = order.referralDetail.referredToProvider
      ? `Dr. ${order.referralDetail.referredToProvider.lastName}`
      : order.referralDetail.referredToExternal ?? "external"
    return `Referral (${order.referralDetail.referralScope}) to ${target}`
  }
  return `Other: ${order.instructions ?? order.orderNumber}`
}

export function OrdersSection({
  encounterId,
  orders,
  providers,
  canEdit,
}: {
  encounterId: string
  orders: OrderWithDetails[]
  providers: { id: string; firstName: string; lastName: string }[]
  canEdit: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [cancelTarget, setCancelTarget] = useState<string | null>(null)
  const [reason, setReason] = useState("")

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Orders</CardTitle>
        {canEdit && <AddOrderDialog encounterId={encounterId} providers={providers} />}
      </CardHeader>
      <CardContent className="grid gap-2">
        {orders.length === 0 && <p className="text-sm text-muted-foreground">No orders placed.</p>}
        {orders.map((order) => (
          <div key={order.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
            <div>
              <p className="font-medium">{orderLabel(order)}</p>
              <p className="text-xs text-muted-foreground">
                {order.orderNumber} · {order.priority}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={STATUS_VARIANT[order.status] ?? "outline"}>{order.status.replace("_", " ")}</Badge>
              {canEdit && order.status === "ordered" && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => {
                    setReason("")
                    setCancelTarget(order.id)
                  }}
                >
                  Cancel
                </Button>
              )}
            </div>
          </div>
        ))}
      </CardContent>

      <Dialog open={cancelTarget !== null} onOpenChange={(open) => !open && setCancelTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel order</DialogTitle>
          </DialogHeader>
          <Input placeholder="Reason for cancellation" value={reason} onChange={(e) => setReason(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelTarget(null)}>
              Back
            </Button>
            <Button
              variant="destructive"
              disabled={pending || !reason.trim()}
              onClick={() => {
                const orderId = cancelTarget!
                setCancelTarget(null)
                startTransition(async () => {
                  await cancelOrderAction(encounterId, orderId, reason)
                  router.refresh()
                })
              }}
            >
              Cancel order
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function AddOrderDialog({
  encounterId,
  providers,
}: {
  encounterId: string
  providers: { id: string; firstName: string; lastName: string }[]
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(createOrderAction, initialState)
  const [orderType, setOrderType] = useState<"lab" | "imaging" | "procedure" | "referral" | "other">("lab")

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus /> Add order
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Place order</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="encounterId" value={encounterId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}

          <div className="grid gap-2">
            <Label htmlFor="orderType">Order type</Label>
            <Select name="orderType" value={orderType} onValueChange={(v) => setOrderType(v as typeof orderType)}>
              <SelectTrigger id="orderType" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="lab">Laboratory</SelectItem>
                <SelectItem value="imaging">Imaging</SelectItem>
                <SelectItem value="procedure">Procedure</SelectItem>
                <SelectItem value="referral">Referral</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="priority">Priority</Label>
            <Select name="priority" defaultValue="routine">
              <SelectTrigger id="priority" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="routine">Routine</SelectItem>
                <SelectItem value="urgent">Urgent</SelectItem>
                <SelectItem value="stat">STAT</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {orderType === "lab" && (
            <>
              <div className="grid gap-2">
                <Label htmlFor="testName">Test name</Label>
                <Input id="testName" name="testName" required />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="specimenType">Specimen type</Label>
                <Input id="specimenType" name="specimenType" />
              </div>
            </>
          )}

          {orderType === "imaging" && (
            <>
              <div className="grid gap-2">
                <Label htmlFor="imagingType">Imaging type</Label>
                <Input id="imagingType" name="imagingType" placeholder="X-Ray, MRI, CT, Ultrasound..." required />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="bodyPart">Body part</Label>
                <Input id="bodyPart" name="bodyPart" />
              </div>
            </>
          )}

          {orderType === "procedure" && (
            <div className="grid gap-2">
              <Label htmlFor="procedureName">Procedure name</Label>
              <Input id="procedureName" name="procedureName" required />
            </div>
          )}

          {orderType === "referral" && (
            <>
              <div className="grid gap-2">
                <Label htmlFor="referralScope">Referral scope</Label>
                <Select name="referralScope" defaultValue="internal">
                  <SelectTrigger id="referralScope" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="internal">Internal</SelectItem>
                    <SelectItem value="external">External</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="referredToProviderId">Internal provider (if internal)</Label>
                <Select name="referredToProviderId">
                  <SelectTrigger id="referredToProviderId" className="w-full">
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
              <div className="grid gap-2">
                <Label htmlFor="referredToExternal">External referral (if external)</Label>
                <Input id="referredToExternal" name="referredToExternal" placeholder="Dr. Smith, City Hospital" />
              </div>
            </>
          )}

          <div className="grid gap-2">
            <Label htmlFor="reason">Reason / clinical notes</Label>
            <Textarea id="reason" name="reason" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="instructions">Instructions</Label>
            <Textarea id="instructions" name="instructions" />
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Placing..." : "Place order"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
