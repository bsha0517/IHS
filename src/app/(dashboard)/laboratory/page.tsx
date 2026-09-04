import Link from "next/link"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listLabQueue } from "@/lib/domains/laboratory/orders"
import { listLabTests, listLabPanels } from "@/lib/domains/laboratory/catalog"
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
import { LabTestDialog } from "@/app/(dashboard)/laboratory/lab-test-dialog"
import { LabPanelDialog } from "@/app/(dashboard)/laboratory/lab-panel-dialog"
import type { $Enums } from "@/generated/prisma/client"

const QUEUE_STATUS_FILTERS = [
  { value: "", label: "All active" },
  { value: "ordered", label: "New (unassigned)" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
] as const

// Targeted backlog closure, item 1: `status` previously flowed straight from
// the URL into a Prisma `ClinicalOrderStatus` filter unvalidated — any value
// outside this real enum list (e.g. the intuitive-looking but non-existent
// "pending", found by P4.5's own load testing) 500'd instead of degrading.
// Same validate-or-default-to-undefined convention `orders/page.tsx`
// already established for this exact enum.
const VALID_STATUSES: $Enums.ClinicalOrderStatus[] = ["draft", "ordered", "acknowledged", "in_progress", "completed", "cancelled"]

export default async function LaboratoryPage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  const session = await getCurrentSession()
  if (!session || !can(session, "lab_result.enter")) redirect("/dashboard")

  const { status, page: pageParam } = await searchParams
  const statusFilter = status && VALID_STATUSES.includes(status as $Enums.ClinicalOrderStatus) ? (status as $Enums.ClinicalOrderStatus) : undefined
  const page = Math.max(1, Number(pageParam ?? 1) || 1)
  const canManageCatalog = can(session, "lab_test.manage")

  const [{ orders: queue, total, totalPages: queueTotalPages }, tests, panels] = await Promise.all([
    listLabQueue(session, { status: statusFilter, page }),
    listLabTests(session),
    listLabPanels(session),
  ])

  const testOptions = tests.map((t) => ({ id: t.id, code: t.code, name: t.name }))

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Laboratory" />

      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger value="queue">Lab Queue</TabsTrigger>
          <TabsTrigger value="catalog">Test Catalog</TabsTrigger>
        </TabsList>

        <TabsContent value="queue" className="grid gap-4">
          {/* P3.5 §30: the server function already supported a status
              filter (`listLabQueue`'s own `filters.status`) — this page
              just never exposed it. */}
          <div className="flex flex-wrap gap-2">
            {QUEUE_STATUS_FILTERS.map((f) => (
              <Button key={f.value} size="sm" variant={(statusFilter ?? "") === f.value ? "default" : "outline"} asChild>
                <Link href={f.value ? `/laboratory?status=${f.value}` : "/laboratory"}>{f.label}</Link>
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
                    <TableHead>Tests</TableHead>
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
                          title="No lab orders"
                          description={statusFilter ? "No lab orders match this filter." : "No pending laboratory orders."}
                          className="border-none"
                        />
                      </TableCell>
                    </TableRow>
                  )}
                  {queue.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell>
                        <Link href={`/laboratory/orders/${o.id}`} className="font-medium hover:underline">
                          {o.orderNumber}
                        </Link>
                      </TableCell>
                      <TableCell>
                        {o.patient.firstName} {o.patient.lastName}
                      </TableCell>
                      <TableCell>{o.patient.mrn}</TableCell>
                      <TableCell>{o.labDetail?.testName ?? "—"}</TableCell>
                      <TableCell>{o.labOrderTests.length > 0 ? `${o.labOrderTests.length} assigned` : "not yet assigned"}</TableCell>
                      <TableCell>
                        {o.orderingProvider.firstName} {o.orderingProvider.lastName}
                      </TableCell>
                      <TableCell>{o.branch.name}</TableCell>
                      <TableCell>
                        {/* P3.5 §31: surfaced, not inferred — a stat/urgent order is
                            visually distinguishable purely because ClinicalOrder's
                            own `priority` enum already carries that meaning. */}
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
          <PaginationControls page={page} totalPages={queueTotalPages} total={total} basePath="/laboratory" searchParams={{ status }} />
        </TabsContent>

        <TabsContent value="catalog" className="grid gap-6">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-medium">Tests</h3>
              {canManageCatalog && <LabTestDialog />}
            </div>
            <Card>
              <CardContent className="pt-6">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Code</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Specimen</TableHead>
                      <TableHead>Result type</TableHead>
                      <TableHead>Range</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tests.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={8} className="p-0">
                          <EmptyState title="No lab tests" description="No lab tests in the catalog yet." className="border-none" />
                        </TableCell>
                      </TableRow>
                    )}
                    {tests.map((t) => (
                      <TableRow key={t.id}>
                        <TableCell className="font-medium">{t.code}</TableCell>
                        <TableCell>{t.name}</TableCell>
                        <TableCell>{t.category}</TableCell>
                        <TableCell>{t.specimenType}</TableCell>
                        <TableCell className="capitalize">{t.resultType}</TableCell>
                        <TableCell>
                          {t.resultType === "numeric"
                            ? t.referenceRangeLow != null && t.referenceRangeHigh != null
                              ? `${t.referenceRangeLow}–${t.referenceRangeHigh} ${t.unit ?? ""}`
                              : "—"
                            : t.referenceRangeText ?? "—"}
                        </TableCell>
                        <TableCell className="text-right">{Number(t.price).toFixed(2)}</TableCell>
                        <TableCell>
                          {canManageCatalog && (
                            <LabTestDialog
                              existing={{
                                id: t.id,
                                code: t.code,
                                name: t.name,
                                category: t.category,
                                specimenType: t.specimenType,
                                resultType: t.resultType,
                                unit: t.unit,
                                referenceRangeLow: t.referenceRangeLow != null ? Number(t.referenceRangeLow) : null,
                                referenceRangeHigh: t.referenceRangeHigh != null ? Number(t.referenceRangeHigh) : null,
                                referenceRangeText: t.referenceRangeText,
                                price: Number(t.price),
                                turnaroundHours: t.turnaroundHours,
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
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-medium">Panels</h3>
              {canManageCatalog && <LabPanelDialog tests={testOptions} />}
            </div>
            <Card>
              <CardContent className="pt-6">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Code</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Members</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {panels.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={4} className="p-0">
                          <EmptyState title="No panels" description="No panels in the catalog yet." className="border-none" />
                        </TableCell>
                      </TableRow>
                    )}
                    {panels.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="font-medium">{p.code}</TableCell>
                        <TableCell>{p.name}</TableCell>
                        <TableCell>{p.tests.map((t) => t.labTest.code).join(", ")}</TableCell>
                        <TableCell className="text-right">{Number(p.price).toFixed(2)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
