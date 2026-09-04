import Link from "next/link"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { getLabOrder } from "@/lib/domains/laboratory/orders"
import { loadOrNotFound } from "@/lib/platform/not-found"
import { listLabTests, listLabPanels } from "@/lib/domains/laboratory/catalog"
import { formatDate, formatDateTime } from "@/lib/utils/dates"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { StatusBadge } from "@/components/ui/status-badge"
import { Button } from "@/components/ui/button"
import { TriangleAlert } from "lucide-react"
import { AssignTestsDialog } from "@/app/(dashboard)/laboratory/orders/[id]/assign-tests-dialog"
import { CollectButton, ReceiveButton, RejectSpecimenButton } from "@/app/(dashboard)/laboratory/orders/[id]/specimen-actions"
import { ResultEntryDialog, VerifyButton } from "@/app/(dashboard)/laboratory/orders/[id]/result-entry-dialog"

export default async function LabOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession()
  // P3.5 §18/§19: widened from `lab_result.enter` alone so a Doctor (who
  // only holds `patient.view`, not the lab-ops permission) has a real,
  // working destination when the encounter links here — see getLabOrder's
  // own comment for the full reasoning. `canOperate` below still gates
  // every actual lab-ops action independently.
  if (!session || (!can(session, "lab_result.enter") && !can(session, "patient.view"))) redirect("/dashboard")

  const { id } = await params
  const canOperate = can(session, "lab_result.enter")
  const canVerify = can(session, "lab_result.verify")
  const [order, tests, panels] = await Promise.all([
    // Targeted backlog closure, item 4 — see loadOrNotFound's own doc comment.
    loadOrNotFound(() => getLabOrder(session, id)),
    canOperate ? listLabTests(session) : Promise.resolve([]),
    canOperate ? listLabPanels(session) : Promise.resolve([]),
  ])

  const testOptions = tests.map((t) => ({ id: t.id, code: t.code, name: t.name, price: Number(t.price) }))
  const panelOptions = panels.map((p) => ({ id: p.id, code: p.code, name: p.name, price: Number(p.price) }))

  return (
    <div className="flex flex-col gap-6">
      {/* P4.7A.1 §29 — same context-bar language as the rest of the app: who
          this order is for, who ordered it, and its overall status, before
          the specimen/test detail below. */}
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
          {order.status === "completed" && (
            <Button size="sm" variant="outline" asChild>
              <Link href={`/laboratory/orders/${order.id}/report`} target="_blank">
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
            <p className="text-sm text-muted-foreground">
              {canOperate
                ? "No structured tests assigned yet — select from the catalog to generate billable lines."
                : "No structured tests assigned yet."}
            </p>
            {canOperate && <AssignTestsDialog clinicalOrderId={order.id} tests={testOptions} panels={panelOptions} />}
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
                  <StatusBadge status={s.status} />
                  {canOperate && s.status === "pending" && (
                    <>
                      <CollectButton specimenId={s.id} clinicalOrderId={order.id} />
                      <RejectSpecimenButton specimenId={s.id} clinicalOrderId={order.id} />
                    </>
                  )}
                  {canOperate && s.status === "collected" && <ReceiveButton specimenId={s.id} clinicalOrderId={order.id} />}
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
            {canOperate && <AssignTestsDialog clinicalOrderId={order.id} tests={testOptions} panels={panelOptions} />}
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
                    <TableCell>
                      {t.abnormalFlag && (
                        // P4.7A.1 §29 — critical results never rely on color
                        // alone: an explicit icon + the word "critical" text,
                        // on top of the destructive tone.
                        <span className="inline-flex items-center gap-1">
                          {t.abnormalFlag.startsWith("critical") && <TriangleAlert className="size-3.5 text-destructive" />}
                          <StatusBadge status={t.abnormalFlag} />
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={t.status} />
                    </TableCell>
                    <TableCell>
                      {/* P2 §20: "processing" removed from this check — LAB_ORDER_TEST_TRANSITIONS (results.ts) allows collected -> processing as a deliberate, optional P1-named step, but no action anywhere actually sets it yet, so this branch was untested dead code, not a reflection of the workflow being unwanted. A future "mark as processing" action would re-add its own branch here alongside the new button, not resurrect this one. */}
                      {canOperate && t.status === "collected" && (
                        <ResultEntryDialog labOrderTestId={t.id} clinicalOrderId={order.id} resultType={t.resultType} testName={t.labTest.name} unit={t.labTest.unit} />
                      )}
                      {t.status === "resulted" && canVerify && <VerifyButton labOrderTestId={t.id} clinicalOrderId={order.id} />}
                      {t.status === "verified" && (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">{t.verifiedAt && formatDate(t.verifiedAt)}</span>
                          {canOperate && (
                            <ResultEntryDialog
                              labOrderTestId={t.id}
                              clinicalOrderId={order.id}
                              resultType={t.resultType}
                              testName={t.labTest.name}
                              unit={t.labTest.unit}
                              mode="amend"
                            />
                          )}
                        </div>
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
