import Link from "next/link"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listRadiologyQueue } from "@/lib/domains/radiology/orders"
import { listImagingServices } from "@/lib/domains/radiology/catalog"
import { formatDateTime } from "@/lib/utils/dates"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { StatusBadge } from "@/components/ui/status-badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PaginationControls } from "@/components/domain/pagination-controls"
import { PageHeader } from "@/components/ui/page-header"
import { EmptyState } from "@/components/ui/empty-state"
import { ImagingServiceDialog } from "@/app/(dashboard)/radiology/imaging-service-dialog"
import type { $Enums } from "@/generated/prisma/client"

const QUEUE_STATUS_FILTERS = [
  { value: "", label: "All active" },
  { value: "ordered", label: "New (unassigned)" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
] as const

// Targeted backlog closure, item 1 — see laboratory/page.tsx's identical comment.
const VALID_STATUSES: $Enums.ClinicalOrderStatus[] = ["draft", "ordered", "acknowledged", "in_progress", "completed", "cancelled"]

export default async function RadiologyPage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  const session = await getCurrentSession()
  if (!session || !can(session, "imaging_order.perform")) redirect("/dashboard")

  const { status, page: pageParam } = await searchParams
  const statusFilter = status && VALID_STATUSES.includes(status as $Enums.ClinicalOrderStatus) ? (status as $Enums.ClinicalOrderStatus) : undefined
  const page = Math.max(1, Number(pageParam ?? 1) || 1)
  const canManageCatalog = can(session, "imaging_service.manage")

  const [{ orders: queue, total, totalPages: queueTotalPages }, services] = await Promise.all([
    listRadiologyQueue(session, { status: statusFilter, page }),
    listImagingServices(session),
  ])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Radiology" module="radiology" />

      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger value="queue">Radiology Queue</TabsTrigger>
          <TabsTrigger value="catalog">Imaging Service Catalog</TabsTrigger>
        </TabsList>

        <TabsContent value="queue" className="grid gap-4">
          <div className="flex flex-wrap gap-2">
            {QUEUE_STATUS_FILTERS.map((f) => (
              <Button key={f.value} size="sm" variant={(statusFilter ?? "") === f.value ? "default" : "outline"} asChild>
                <Link href={f.value ? `/radiology?status=${f.value}` : "/radiology"}>{f.label}</Link>
              </Button>
            ))}
          </div>
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order #</TableHead>
                    <TableHead>Patient</TableHead>
                    <TableHead>MRN</TableHead>
                    <TableHead>Order intent</TableHead>
                    <TableHead>Modality</TableHead>
                    <TableHead>Ordering provider</TableHead>
                    <TableHead>Branch</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>Ordered</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queue.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={10} className="p-0">
                        <EmptyState
                          title="No imaging orders"
                          description={statusFilter ? "No imaging orders match this filter." : "No imaging studies awaiting processing."}
                          className="border-none"
                        />
                      </TableCell>
                    </TableRow>
                  )}
                  {queue.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell>
                        <Link href={`/radiology/orders/${o.id}`} className="font-medium hover:underline">
                          {o.orderNumber}
                        </Link>
                      </TableCell>
                      <TableCell>
                        {o.patient.firstName} {o.patient.lastName}
                      </TableCell>
                      <TableCell>{o.patient.mrn}</TableCell>
                      <TableCell>
                        {o.imagingDetail?.imagingType ?? "—"}
                        {o.imagingDetail?.bodyPart ? ` (${o.imagingDetail.bodyPart})` : ""}
                      </TableCell>
                      <TableCell>{o.imagingOrder ? o.imagingOrder.imagingService.category : "—"}</TableCell>
                      <TableCell>
                        {o.orderingProvider.firstName} {o.orderingProvider.lastName}
                      </TableCell>
                      <TableCell>{o.branch.name}</TableCell>
                      <TableCell>
                        <Badge variant={o.priority === "stat" ? "destructive" : o.priority === "urgent" ? "secondary" : "outline"} className="capitalize">
                          {o.priority}
                        </Badge>
                      </TableCell>
                      <TableCell>{formatDateTime(o.orderedAt)}</TableCell>
                      <TableCell>
                        <StatusBadge status={o.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <PaginationControls page={page} totalPages={queueTotalPages} total={total} basePath="/radiology" searchParams={{ status }} />
        </TabsContent>

        <TabsContent value="catalog" className="grid gap-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-medium">Imaging Services</h3>
            {canManageCatalog && <ImagingServiceDialog />}
          </div>
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Modality</TableHead>
                    <TableHead>Body part</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {services.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="p-0">
                        <EmptyState title="No imaging services" description="No imaging services in the catalog yet." className="border-none" />
                      </TableCell>
                    </TableRow>
                  )}
                  {services.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">{s.code}</TableCell>
                      <TableCell>{s.name}</TableCell>
                      <TableCell>{s.category}</TableCell>
                      <TableCell>{s.bodyPart ?? "—"}</TableCell>
                      <TableCell className="text-right">{Number(s.price).toFixed(2)}</TableCell>
                      <TableCell>
                        {canManageCatalog && (
                          <ImagingServiceDialog
                            existing={{
                              id: s.id,
                              code: s.code,
                              name: s.name,
                              category: s.category,
                              bodyPart: s.bodyPart,
                              price: Number(s.price),
                              turnaroundHours: s.turnaroundHours,
                            }}
                          />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
