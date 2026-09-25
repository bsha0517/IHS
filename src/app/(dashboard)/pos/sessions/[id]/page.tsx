import Link from "next/link"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { getCashierSession } from "@/lib/domains/billing/cashier"
import { formatDateTime } from "@/lib/utils/dates"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DetailHeader } from "@/components/ui/page-header"

export default async function CashierSessionSummaryPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession()
  if (!session) redirect("/dashboard")

  const { id } = await params
  const cashierSession = await getCashierSession(session, id)

  const varianceLabel =
    cashierSession.variance === null
      ? "—"
      : Number(cashierSession.variance) === 0
        ? "Balanced"
        : Number(cashierSession.variance) > 0
          ? `+${Number(cashierSession.variance).toFixed(2)} (over)`
          : `${Number(cashierSession.variance).toFixed(2)} (short)`

  return (
    <div className="flex flex-col gap-6">
      <DetailHeader
        module="billing"
        title="Register closed"
        badge={<Badge variant={Number(cashierSession.variance) === 0 ? "success" : "destructive"}>{varianceLabel}</Badge>}
        actions={
          <Button asChild size="sm">
            <Link href="/pos">Back to POS</Link>
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Session summary</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
          <p>
            <span className="text-muted-foreground">Opened:</span> {formatDateTime(cashierSession.openedAt)}
          </p>
          <p>
            <span className="text-muted-foreground">Closed:</span>{" "}
            {cashierSession.closedAt ? formatDateTime(cashierSession.closedAt) : "—"}
          </p>
          <p>
            <span className="text-muted-foreground">Opening cash:</span> {Number(cashierSession.openingCash).toFixed(2)}
          </p>
          <p>
            <span className="text-muted-foreground">Expected cash:</span>{" "}
            {cashierSession.expectedCash !== null ? Number(cashierSession.expectedCash).toFixed(2) : "—"}
          </p>
          <p>
            <span className="text-muted-foreground">Actual cash:</span>{" "}
            {cashierSession.actualCash !== null ? Number(cashierSession.actualCash).toFixed(2) : "—"}
          </p>
          <p className="flex items-center gap-2">
            <span className="text-muted-foreground">Variance:</span>
            <Badge variant={Number(cashierSession.variance) === 0 ? "success" : "destructive"}>{varianceLabel}</Badge>
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cash movements</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          {cashierSession.cashMovements.length === 0 && <p className="text-muted-foreground">None recorded.</p>}
          {cashierSession.cashMovements.map((m) => (
            <div key={m.id} className="flex items-center justify-between rounded-md border border-border p-2">
              <span>
                {m.reason} <span className="text-muted-foreground">({formatDateTime(m.recordedAt)})</span>
              </span>
              <span>
                {m.direction === "in" ? "+" : "-"}
                {Number(m.amount).toFixed(2)}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payments received ({cashierSession.payments.length})</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          {cashierSession.payments.length === 0 && <p className="text-muted-foreground">None recorded.</p>}
          {cashierSession.payments.map((p) => (
            <div key={p.id} className="flex items-center justify-between rounded-md border border-border p-2">
              <span>
                {p.receiptNumber} <span className="capitalize text-muted-foreground">({p.method})</span>
              </span>
              <span>{Number(p.amount).toFixed(2)}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
