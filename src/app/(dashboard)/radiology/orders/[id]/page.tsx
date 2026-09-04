import Link from "next/link"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { getRadiologyOrder } from "@/lib/domains/radiology/orders"
import { loadOrNotFound } from "@/lib/platform/not-found"
import { listImagingServices } from "@/lib/domains/radiology/catalog"
import { listRooms } from "@/lib/domains/identity/org-structure"
import { formatDate, formatDateTime } from "@/lib/utils/dates"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { StatusBadge } from "@/components/ui/status-badge"
import { Button } from "@/components/ui/button"
import { AssignServiceDialog } from "@/app/(dashboard)/radiology/orders/[id]/assign-service-dialog"
import { ScheduleDialog } from "@/app/(dashboard)/radiology/orders/[id]/schedule-dialog"
import { MarkPerformedButton, VerifyButton } from "@/app/(dashboard)/radiology/orders/[id]/order-actions"
import { ReportDialog, AmendReportDialog } from "@/app/(dashboard)/radiology/orders/[id]/report-dialog"

export default async function RadiologyOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession()
  // P3.5 §18/§19: widened from `imaging_order.perform` alone so a Doctor
  // (who only holds `patient.view`) has a real destination when the
  // encounter links here — see getRadiologyOrder's own comment.
  // `canOperate` below still gates every actual radiology-ops action
  // independently.
  if (!session || (!can(session, "imaging_order.perform") && !can(session, "patient.view"))) redirect("/dashboard")

  const { id } = await params
  const canOperate = can(session, "imaging_order.perform")
  const canViewRooms = can(session, "room.view")
  const canVerify = can(session, "imaging_result.verify")
  const [order, services, rooms] = await Promise.all([
    // Targeted backlog closure, item 4 — see loadOrNotFound's own doc comment.
    loadOrNotFound(() => getRadiologyOrder(session, id)),
    canOperate ? listImagingServices(session) : Promise.resolve([]),
    canOperate && canViewRooms ? listRooms(session) : Promise.resolve([]),
  ])

  const serviceOptions = services.map((s) => ({ id: s.id, code: s.code, name: s.name, price: Number(s.price) }))
  const roomOptions = rooms.map((r) => ({ id: r.id, name: r.name, code: r.code }))
  const io = order.imagingOrder
  // Targeted backlog closure, item 7: the CURRENT report is the latest
  // amendment if one exists, otherwise the original ImagingOrder fields —
  // derived here, never a separate stored flag (see amendImagingReport's
  // own doc comment for why). `io.amendments` is already ordered oldest
  // first (radiology/orders.ts's ORDER_INCLUDE).
  const latestAmendment = io?.amendments[io.amendments.length - 1] ?? null
  const currentReportText = latestAmendment?.reportText ?? io?.reportText ?? null
  const currentImpression = latestAmendment?.impression ?? io?.impression ?? null

  return (
    <div className="flex flex-col gap-6">
      {/* P4.7A.1 §30 — same context-bar language as Laboratory's own order
          detail page. */}
      <Card className="border-l-4 border-l-primary">
        <CardContent className="flex flex-wrap items-center justify-between gap-4 pt-6">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">{order.orderNumber}</h1>
              <StatusBadge status={order.status} />
            </div>
            <p className="text-sm text-muted-foreground">
              <Link href={`/patients/${order.patientId}`} className="hover:underline">
                {order.patient.firstName} {order.patient.lastName}
              </Link>{" "}
              ({order.patient.mrn}) · Ordered by {order.orderingProvider.firstName} {order.orderingProvider.lastName}
            </p>
          </div>
          {io?.status === "verified" && (
            <Button size="sm" variant="outline" asChild>
              <Link href={`/radiology/orders/${order.id}/report`} target="_blank">
                View report
              </Link>
            </Button>
          )}
        </CardContent>
      </Card>

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
            <p className="text-sm text-muted-foreground">
              {canOperate ? "Not yet assigned — select from the catalog to generate a billable, schedulable study." : "Not yet assigned."}
            </p>
            {canOperate && <AssignServiceDialog clinicalOrderId={order.id} services={serviceOptions} />}
          </CardContent>
        </Card>
      )}

      {io && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">{io.imagingService.name}</CardTitle>
            <StatusBadge status={io.status} />
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
            {currentReportText && (
              <div className="grid gap-1">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Report</span>
                  {io.amendments.length > 0 && (
                    <span className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
                      Amended {io.amendments.length > 1 ? `${io.amendments.length}×` : ""} — this is the current report
                    </span>
                  )}
                </div>
                <p className="rounded-md border border-border p-2">{currentReportText}</p>
                {currentImpression && <p className="text-muted-foreground">Impression: {currentImpression}</p>}
              </div>
            )}
            {io.verifiedAt && (
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Verified</span>
                <span>{formatDate(io.verifiedAt)}</span>
              </div>
            )}

            {/* Targeted backlog closure, item 7: the original + every
                amendment, oldest first, each independently attributed —
                "amendment history remains accessible," not folded away. */}
            {io.amendments.length > 0 && (
              <div className="grid gap-2 border-t border-border pt-3">
                <span className="text-xs font-medium text-muted-foreground">Amendment history</span>
                <div className="grid gap-2 text-xs">
                  <div className="rounded-md border border-border p-2">
                    <p className="mb-1 flex items-center gap-2 font-medium text-muted-foreground">
                      Original — {io.reportedAt ? formatDateTime(io.reportedAt) : "—"}
                      {io.amendments.length === 0 && <StatusBadge status="current" />}
                    </p>
                    <p>{io.reportText}</p>
                    {io.impression && <p className="text-muted-foreground">Impression: {io.impression}</p>}
                  </div>
                  {io.amendments.map((a, i) => {
                    const isCurrent = i === io.amendments.length - 1
                    return (
                      <div key={a.id} className={`rounded-md border p-2 ${isCurrent ? "border-primary/40" : "border-border"}`}>
                        <p className="mb-1 flex items-center gap-2 font-medium text-muted-foreground">
                          Amendment {i + 1} — {formatDateTime(a.amendedAt)} — {a.amendedByUser.firstName} {a.amendedByUser.lastName}
                          {isCurrent && <StatusBadge status="current" />}
                        </p>
                        <p>{a.reportText}</p>
                        {a.impression && <p className="text-muted-foreground">Impression: {a.impression}</p>}
                        <p className="mt-1 text-muted-foreground">Reason: {a.reason}</p>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              {canOperate && (io.status === "ordered" || io.status === "scheduled") && (
                <ScheduleDialog imagingOrderId={io.id} clinicalOrderId={order.id} rooms={roomOptions} />
              )}
              {canOperate && io.status === "scheduled" && <MarkPerformedButton imagingOrderId={io.id} clinicalOrderId={order.id} />}
              {canOperate && io.status === "performed" && <ReportDialog imagingOrderId={io.id} clinicalOrderId={order.id} />}
              {io.status === "reported" && canVerify && <VerifyButton imagingOrderId={io.id} clinicalOrderId={order.id} />}
              {canOperate && io.status === "verified" && currentReportText && (
                <AmendReportDialog
                  imagingOrderId={io.id}
                  clinicalOrderId={order.id}
                  currentReportText={currentReportText}
                  currentImpression={currentImpression}
                />
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
