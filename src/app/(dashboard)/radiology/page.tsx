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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ImagingServiceDialog } from "@/app/(dashboard)/radiology/imaging-service-dialog"

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  ordered: "outline",
  acknowledged: "outline",
  in_progress: "secondary",
  completed: "default",
  cancelled: "destructive",
}

export default async function RadiologyPage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "imaging_order.perform")) redirect("/dashboard")

  const canManageCatalog = can(session, "imaging_service.manage")

  const [queue, services] = await Promise.all([listRadiologyQueue(session), listImagingServices(session)])

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Radiology</h1>

      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger value="queue">Radiology Queue</TabsTrigger>
          <TabsTrigger value="catalog">Imaging Service Catalog</TabsTrigger>
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
                    <TableHead>Assigned service</TableHead>
                    <TableHead>Ordered</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queue.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground">
                        No imaging orders in the queue.
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
                      <TableCell>
                        {o.imagingDetail?.imagingType ?? "—"}
                        {o.imagingDetail?.bodyPart ? ` (${o.imagingDetail.bodyPart})` : ""}
                      </TableCell>
                      <TableCell>{o.imagingOrder ? o.imagingOrder.imagingService.name : "not yet assigned"}</TableCell>
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
                      <TableCell colSpan={6} className="text-center text-muted-foreground">
                        No imaging services yet.
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
