import Link from "next/link"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { getRadiologyOrder } from "@/lib/domains/radiology/orders"
import { listImagingServices } from "@/lib/domains/radiology/catalog"
import { listRooms } from "@/lib/domains/identity/org-structure"
import { formatDate, formatDateTime } from "@/lib/utils/dates"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AssignServiceDialog } from "@/app/(dashboard)/radiology/orders/[id]/assign-service-dialog"
import { ScheduleDialog } from "@/app/(dashboard)/radiology/orders/[id]/schedule-dialog"
import { MarkPerformedButton, VerifyButton } from "@/app/(dashboard)/radiology/orders/[id]/order-actions"
import { ReportDialog } from "@/app/(dashboard)/radiology/orders/[id]/report-dialog"

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  ordered: "outline",
  scheduled: "secondary",
  performed: "secondary",
  reported: "secondary",
  verified: "default",
  cancelled: "destructive",
}

export default async function RadiologyOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession()
  if (!session || !can(session, "imaging_order.perform")) redirect("/dashboard")

  const { id } = await params
  const canVerify = can(session, "imaging_result.verify")
  const [order, services, rooms] = await Promise.all([getRadiologyOrder(session, id), listImagingServices(session), listRooms(session)])

  const serviceOptions = services.map((s) => ({ id: s.id, code: s.code, name: s.name, price: Number(s.price) }))
  const roomOptions = rooms.map((r) => ({ id: r.id, name: r.name, code: r.code }))
  const io = order.imagingOrder

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{order.orderNumber}</h1>
          <p className="text-sm text-muted-foreground">
            {order.patient.firstName} {order.patient.lastName} ({order.patient.mrn}) · Ordered by {order.orderingProvider.firstName}{" "}
            {order.orderingProvider.lastName}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={order.status === "completed" ? "default" : "outline"}>{order.status.replace("_", " ")}</Badge>
          {io?.status === "verified" && (
            <Button size="sm" variant="outline" asChild>
              <Link href={`/radiology/orders/${order.id}/report`} target="_blank">
                View report
              </Link>
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Order intent</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1.5 text-sm">
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Requested</span>
            <span>
              {order.imagingDetail?.imagingType ?? "—"}
              {order.imagingDetail?.bodyPart ? ` (${order.imagingDetail.bodyPart})` : ""}
            </span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Priority</span>
            <span className="capitalize">{order.priority}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Ordered</span>
            <span>{formatDateTime(order.orderedAt)}</span>
          </div>
          {order.imagingDetail?.clinicalNotes && (
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Clinical notes</span>
              <span>{order.imagingDetail.clinicalNotes}</span>
            </div>
          )}
          {order.instructions && (
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Instructions</span>
              <span>{order.instructions}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {!io && (
        <Card>
          <CardContent className="flex items-center justify-between pt-6">
            <p className="text-sm text-muted-foreground">Not yet assigned — select from the catalog to generate a billable, schedulable study.</p>
            <AssignServiceDialog clinicalOrderId={order.id} services={serviceOptions} />
          </CardContent>
        </Card>
      )}

      {io && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">{io.imagingService.name}</CardTitle>
            <Badge variant={STATUS_VARIANT[io.status] ?? "outline"}>{io.status}</Badge>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Accession #</span>
              <span>{io.accessionNumber}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Scheduled</span>
              <span>{io.scheduledAt ? formatDateTime(io.scheduledAt) : "—"}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Room</span>
              <span>{io.room?.name ?? "—"}</span>
            </div>
            {io.performedAt && (
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Performed</span>
                <span>{formatDateTime(io.performedAt)}</span>
              </div>
            )}
            {io.reportText && (
              <div className="grid gap-1">
                <span className="text-muted-foreground">Report</span>
                <p className="rounded-md border border-border p-2">{io.reportText}</p>
                {io.impression && <p className="text-muted-foreground">Impression: {io.impression}</p>}
              </div>
            )}
            {io.verifiedAt && (
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Verified</span>
                <span>{formatDate(io.verifiedAt)}</span>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              {(io.status === "ordered" || io.status === "scheduled") && (
                <ScheduleDialog imagingOrderId={io.id} clinicalOrderId={order.id} rooms={roomOptions} />
              )}
              {io.status === "scheduled" && <MarkPerformedButton imagingOrderId={io.id} clinicalOrderId={order.id} />}
              {io.status === "performed" && <ReportDialog imagingOrderId={io.id} clinicalOrderId={order.id} />}
              {io.status === "reported" && canVerify && <VerifyButton imagingOrderId={io.id} clinicalOrderId={order.id} />}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
