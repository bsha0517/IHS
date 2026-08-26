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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { LabTestDialog } from "@/app/(dashboard)/laboratory/lab-test-dialog"
import { LabPanelDialog } from "@/app/(dashboard)/laboratory/lab-panel-dialog"

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  ordered: "outline",
  acknowledged: "outline",
  in_progress: "secondary",
  completed: "default",
  cancelled: "destructive",
}

export default async function LaboratoryPage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "lab_result.enter")) redirect("/dashboard")

  const canManageCatalog = can(session, "lab_test.manage")

  const [queue, tests, panels] = await Promise.all([listLabQueue(session), listLabTests(session), listLabPanels(session)])

  const testOptions = tests.map((t) => ({ id: t.id, code: t.code, name: t.name }))

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Laboratory</h1>

      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger value="queue">Lab Queue</TabsTrigger>
          <TabsTrigger value="catalog">Test Catalog</TabsTrigger>
        </TabsList>

        <TabsContent value="queue" className="grid gap-4">
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order #</TableHead>
                    <TableHead>Patient</TableHead>
                    <TableHead>Order intent</TableHead>
                    <TableHead>Tests</TableHead>
                    <TableHead>Ordered</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queue.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground">
                        No lab orders in the queue.
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
                      <TableCell>{o.labDetail?.testName ?? "—"}</TableCell>
                      <TableCell>{o.labOrderTests.length > 0 ? `${o.labOrderTests.length} assigned` : "not yet assigned"}</TableCell>
                      <TableCell>{formatDateTime(o.orderedAt)}</TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[o.status] ?? "outline"}>{o.status.replace("_", " ")}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
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
                        <TableCell colSpan={8} className="text-center text-muted-foreground">
                          No lab tests yet.
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
                        <TableCell colSpan={4} className="text-center text-muted-foreground">
                          No panels yet.
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
