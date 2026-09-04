"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { StatusBadge } from "@/components/ui/status-badge"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { EmptyState } from "@/components/ui/empty-state"
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

/** P4.7A.1 §12 — the order's own type badge (Lab / Imaging / Procedure /
 * Referral / Other), kept visually distinct from its status badge so the
 * two never blur into one another — orders stay clearly categorized by
 * destination/workflow, not just by state. */
function orderTypeLabel(order: OrderWithDetails): string {
  if (order.labDetail) return "Lab"
  if (order.imagingDetail) return "Imaging"
  if (order.procedureDetail) return "Procedure"
  if (order.referralDetail) return "Referral"
  return "Other"
}

function orderLabel(order: OrderWithDetails): string {
  if (order.labDetail) return order.labDetail.testName
  if (order.imagingDetail) return order.imagingDetail.imagingType
  if (order.procedureDetail) return order.procedureDetail.procedureName
  if (order.referralDetail) {
    const target = order.referralDetail.referredToProvider
      ? `Dr. ${order.referralDetail.referredToProvider.lastName}`
      : order.referralDetail.referredToExternal ?? "external"
    return `${order.referralDetail.referralScope} referral to ${target}`
  }
  return order.instructions ?? order.orderNumber
}

/**
 * P3.5 §18/§19: closes the P3.3 backlog item — "no result destination link
 * from an encounter's Lab/Imaging order to its eventual result." The
 * ClinicalOrder's own status already tells the whole story with no extra
 * query: "ordered" means not yet assigned (nothing to open yet — no link,
 * no dead end), "in_progress" means assigned/processing (a real order page
 * exists — link to it, but don't call it a "Result" yet), "completed"
 * means the result/report is verified (link, labeled as the result). Both
 * `/laboratory/orders/[id]` and `/radiology/orders/[id]` are the same
 * pages lab/radiology staff already use — now readable (not writable) by
 * whoever can view the patient, so this is never a dead link.
 */
function resultLink(order: OrderWithDetails): { href: string; label: string } | null {
  if (order.orderType === "lab") {
    if (order.status === "completed") return { href: `/laboratory/orders/${order.id}`, label: "View Result" }
    if (order.status === "in_progress") return { href: `/laboratory/orders/${order.id}`, label: "View Lab Order" }
  }
  if (order.orderType === "imaging") {
    if (order.status === "completed") return { href: `/radiology/orders/${order.id}`, label: "View Report" }
    if (order.status === "in_progress") return { href: `/radiology/orders/${order.id}`, label: "View Imaging Order" }
  }
  return null
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
  // Targeted backlog closure, item 5 — same pattern as diagnoses-section.tsx.
  const [actionError, setActionError] = useState<string | null>(null)

  function run(fn: () => Promise<ActionState>) {
    setActionError(null)
    startTransition(async () => {
      try {
        const result = await fn()
        if (result?.error) setActionError(result.error)
        else router.refresh()
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "That action couldn't be completed.")
      }
    })
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Orders</CardTitle>
        {canEdit && <AddOrderDialog encounterId={encounterId} providers={providers} />}
      </CardHeader>
      <CardContent className="grid gap-2">
        {actionError && (
          <Alert variant="destructive">
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        )}
        {orders.length === 0 && <EmptyState title="No orders placed" />}
        {orders.map((order) => {
          const link = resultLink(order)
          return (
          <div key={order.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
            <div className="flex items-center gap-2">
              <Badge variant="neutral" className="shrink-0">{orderTypeLabel(order)}</Badge>
              <div>
                <p className="font-medium">{orderLabel(order)}</p>
                <p className="text-xs text-muted-foreground">
                  {order.orderNumber} · {order.priority}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge status={order.status} />
              {link && (
                <Button size="sm" variant="ghost" asChild>
                  <Link href={link.href}>{link.label}</Link>
                </Button>
              )}
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
          )
        })}
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
                run(() => cancelOrderAction(encounterId, orderId, reason))
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
