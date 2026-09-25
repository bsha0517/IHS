import Link from "next/link"
import { redirect } from "next/navigation"
import { Search } from "lucide-react"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listOrders } from "@/lib/domains/clinical/orders"
import { Card, CardContent } from "@/components/ui/card"
import { PageHeader } from "@/components/ui/page-header"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { formatDateTime } from "@/lib/utils/dates"
import type { $Enums } from "@/generated/prisma/client"

const STATUSES: $Enums.ClinicalOrderStatus[] = ["draft", "ordered", "acknowledged", "in_progress", "completed", "cancelled"]

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  draft: "outline",
  ordered: "outline",
  acknowledged: "outline",
  in_progress: "secondary",
  completed: "default",
  cancelled: "destructive",
}

const PRIORITY_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  routine: "outline",
  urgent: "secondary",
  stat: "destructive",
}

function orderDetail(order: Awaited<ReturnType<typeof listOrders>>["orders"][number]): string {
  switch (order.orderType) {
    case "lab":
      return order.labDetail?.testName ?? "—"
    case "imaging":
      return [order.imagingDetail?.imagingType, order.imagingDetail?.bodyPart].filter(Boolean).join(" — ") || "—"
    case "procedure":
      return order.procedureDetail?.procedureName ?? "—"
    case "referral":
      return order.referralDetail?.referredToProvider
        ? `${order.referralDetail.referredToProvider.firstName} ${order.referralDetail.referredToProvider.lastName}`
        : (order.referralDetail?.referredToExternal ?? "—")
    default:
      return order.instructions ?? "—"
  }
}

function queryString(params: Record<string, string | undefined>) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value)
  }
  const str = search.toString()
  return str ? `?${str}` : ""
}

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>
}) {
  const session = await getCurrentSession()
  if (!session || !can(session, "encounter.view")) redirect("/dashboard")

  const { q, status, page: pageParam } = await searchParams
  const page = Math.max(1, Number(pageParam ?? 1) || 1)
  const statusFilter = status && STATUSES.includes(status as $Enums.ClinicalOrderStatus) ? (status as $Enums.ClinicalOrderStatus) : undefined

  const { orders, total, totalPages } = await listOrders(session, { search: q, status: statusFilter, page })

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Orders"
        module="clinical"
        description={`${total} clinical order(s) — every order type placed across the practice. Lab and imaging orders also have their own dedicated queues under Laboratory and Radiology.`}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <form className="flex max-w-md items-center gap-2">
          {status && <input type="hidden" name="status" value={status} />}
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input name="q" defaultValue={q} placeholder="Search by order #, or patient" className="pl-8" />
          </div>
          <Button type="submit" variant="outline" size="sm">
            Search
          </Button>
        </form>

        <div className="flex flex-wrap gap-1">
          <Button variant={!status ? "secondary" : "ghost"} size="sm" asChild>
            <Link href={`/orders${queryString({ q })}`}>All</Link>
          </Button>
          {STATUSES.map((s) => (
            <Button key={s} variant={status === s ? "secondary" : "ghost"} size="sm" asChild>
              <Link href={`/orders${queryString({ q, status: s })}`} className="capitalize">
                {s.replace(/_/g, " ")}
              </Link>
            </Button>
          ))}
        </div>
      </div>

      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order #</TableHead>
                <TableHead>Patient</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Detail</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Ordered</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    No orders found.
                  </TableCell>
                </TableRow>
              )}
              {orders.map((order) => (
                <TableRow key={order.id}>
                  <TableCell>
                    <Link href={`/encounters/${order.encounterId}`} className="font-medium hover:underline">
                      {order.orderNumber}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/patients/${order.patientId}`} className="hover:underline">
                      {order.patient.firstName} {order.patient.lastName}
                    </Link>
                  </TableCell>
                  <TableCell className="capitalize">{order.orderType}</TableCell>
                  <TableCell>{orderDetail(order)}</TableCell>
                  <TableCell>
                    <Badge variant={PRIORITY_VARIANT[order.priority] ?? "outline"} className="capitalize">
                      {order.priority}
                    </Badge>
                  </TableCell>
                  <TableCell>{formatDateTime(order.orderedAt)}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[order.status] ?? "outline"} className="capitalize">
                      {order.status.replace(/_/g, " ")}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} asChild={page > 1}>
                {page > 1 ? <Link href={`/orders${queryString({ q, status, page: String(page - 1) })}`}>Previous</Link> : <span>Previous</span>}
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {page} of {totalPages}
              </span>
              <Button variant="outline" size="sm" disabled={page >= totalPages} asChild={page < totalPages}>
                {page < totalPages ? (
                  <Link href={`/orders${queryString({ q, status, page: String(page + 1) })}`}>Next</Link>
                ) : (
                  <span>Next</span>
                )}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
