import Link from "next/link"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { getLabOrder } from "@/lib/domains/laboratory/orders"
import { listLabTests, listLabPanels } from "@/lib/domains/laboratory/catalog"
import { formatDate, formatDateTime } from "@/lib/utils/dates"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AssignTestsDialog } from "@/app/(dashboard)/laboratory/orders/[id]/assign-tests-dialog"
import { CollectButton, ReceiveButton, RejectSpecimenButton } from "@/app/(dashboard)/laboratory/orders/[id]/specimen-actions"
import { ResultEntryDialog, VerifyButton } from "@/app/(dashboard)/laboratory/orders/[id]/result-entry-dialog"

const FLAG_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
  normal: "default",
  low: "secondary",
  high: "secondary",
  critical_low: "destructive",
  critical_high: "destructive",
}

export default async function LabOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession()
  if (!session || !can(session, "lab_result.enter")) redirect("/dashboard")

  const { id } = await params
  const canVerify = can(session, "lab_result.verify")
  const [order, tests, panels] = await Promise.all([getLabOrder(session, id), listLabTests(session), listLabPanels(session)])

  const testOptions = tests.map((t) => ({ id: t.id, code: t.code, name: t.name, price: Number(t.price) }))
  const panelOptions = panels.map((p) => ({ id: p.id, code: p.code, name: p.name, price: Number(p.price) }))

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
          {order.status === "completed" && (
            <Button size="sm" variant="outline" asChild>
              <Link href={`/laboratory/orders/${order.id}/report`} target="_blank">
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
            <span>{order.labDetail?.testName ?? "—"}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Priority</span>
            <span className="capitalize">{order.priority}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Ordered</span>
            <span>{formatDateTime(order.orderedAt)}</span>
          </div>
          {order.instructions && (
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Instructions</span>
              <span>{order.instructions}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {order.labOrderTests.length === 0 && (
        <Card>
          <CardContent className="flex items-center justify-between pt-6">
            <p className="text-sm text-muted-foreground">No structured tests assigned yet — select from the catalog to generate billable lines.</p>
            <AssignTestsDialog clinicalOrderId={order.id} tests={testOptions} panels={panelOptions} />
          </CardContent>
        </Card>
      )}

      {order.specimens.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Specimens</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            {order.specimens.map((s) => (
              <div key={s.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                <div>
                  <span className="font-medium">{s.specimenNumber}</span> · {s.specimenType}
                  {s.collectedAt && <span className="text-muted-foreground"> · collected {formatDateTime(s.collectedAt)}</span>}
                  {s.rejectionReason && <span className="text-destructive"> · rejected: {s.rejectionReason}</span>}
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={s.status === "rejected" ? "destructive" : s.status === "pending" ? "outline" : "default"}>{s.status}</Badge>
                  {s.status === "pending" && (
                    <>
                      <CollectButton specimenId={s.id} clinicalOrderId={order.id} />
                      <RejectSpecimenButton specimenId={s.id} clinicalOrderId={order.id} />
                    </>
                  )}
                  {s.status === "collected" && <ReceiveButton specimenId={s.id} clinicalOrderId={order.id} />}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {order.labOrderTests.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Tests</CardTitle>
            <AssignTestsDialog clinicalOrderId={order.id} tests={testOptions} panels={panelOptions} />
          </CardHeader>
          <CardContent className="pt-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Test</TableHead>
                  <TableHead>Panel</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead>Range</TableHead>
                  <TableHead>Flag</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {order.labOrderTests.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">{t.labTest.name}</TableCell>
                    <TableCell>{t.labPanel?.name ?? "—"}</TableCell>
                    <TableCell>
                      {t.numericValue != null ? `${t.numericValue} ${t.unit ?? ""}` : t.textValue ?? "—"}
                    </TableCell>
                    <TableCell>
                      {t.referenceRangeLow != null && t.referenceRangeHigh != null
                        ? `${t.referenceRangeLow}–${t.referenceRangeHigh}`
                        : t.referenceRangeText ?? "—"}
                    </TableCell>
                    <TableCell>{t.abnormalFlag && <Badge variant={FLAG_VARIANT[t.abnormalFlag] ?? "outline"}>{t.abnormalFlag.replace("_", " ")}</Badge>}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{t.status}</Badge>
                    </TableCell>
                    <TableCell>
                      {(t.status === "collected" || t.status === "processing") && (
                        <ResultEntryDialog labOrderTestId={t.id} clinicalOrderId={order.id} resultType={t.resultType} testName={t.labTest.name} unit={t.labTest.unit} />
                      )}
                      {t.status === "resulted" && canVerify && <VerifyButton labOrderTestId={t.id} clinicalOrderId={order.id} />}
                      {t.status === "verified" && (
                        <span className="text-xs text-muted-foreground">
                          {t.verifiedAt && formatDate(t.verifiedAt)}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
