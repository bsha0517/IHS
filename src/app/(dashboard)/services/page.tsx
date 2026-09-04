import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listServices } from "@/lib/domains/services/service"
import { listDepartments } from "@/lib/domains/identity/org-structure"
import { listProviders } from "@/lib/domains/providers/service"
import { listProducts } from "@/lib/domains/inventory/products"
import { listAllServiceConsumption } from "@/lib/domains/inventory/consumption-templates"
import { Card, CardContent } from "@/components/ui/card"
import { PageHeader } from "@/components/ui/page-header"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { ServiceDialog } from "@/app/(dashboard)/services/service-dialog"
import { ConsumptionTemplateDialog } from "@/app/(dashboard)/services/consumption-template-dialog"

export default async function ServicesPage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "service.view")) redirect("/dashboard")

  const [services, departments, allProviders, products, consumptionByService] = await Promise.all([
    listServices(session),
    listDepartments(session),
    listProviders(session),
    can(session, "inventory.view") ? listProducts(session) : Promise.resolve([]),
    can(session, "inventory.view") ? listAllServiceConsumption(session) : Promise.resolve(new Map()),
  ])
  const canManage = can(session, "service.manage")
  const productOptions = products.map((p) => ({ id: p.id, name: p.name, unit: p.unit }))

  // Prisma's Decimal (consultationFee/price) isn't a plain object, so it can't
  // cross the Server->Client Component boundary — map down to plain fields
  // before handing these off to the client dialog below.
  const providers = allProviders.map((p) => ({ id: p.id, firstName: p.firstName, lastName: p.lastName }))

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Services"
        description={`${services.length} service(s)`}
        primaryAction={canManage && <ServiceDialog departments={departments} providers={providers} />}
      />

      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {services.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    No services yet.
                  </TableCell>
                </TableRow>
              )}
              {services.map((service) => (
                <TableRow key={service.id}>
                  <TableCell className="font-medium">{service.code}</TableCell>
                  <TableCell>{service.name}</TableCell>
                  <TableCell>{service.category}</TableCell>
                  <TableCell>{service.durationMinutes} min</TableCell>
                  <TableCell>{Number(service.price).toFixed(2)}</TableCell>
                  <TableCell>
                    <Badge variant={service.isActive ? "default" : "secondary"}>
                      {service.isActive ? "active" : "inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell className="flex items-center gap-1">
                    {productOptions.length > 0 && (
                      <ConsumptionTemplateDialog
                        serviceId={service.id}
                        serviceName={service.name}
                        products={productOptions}
                        existing={consumptionByService.get(service.id) ?? []}
                      />
                    )}
                    {canManage && (
                      <ServiceDialog
                        departments={departments}
                        providers={providers}
                        existing={{
                          id: service.id,
                          code: service.code,
                          name: service.name,
                          category: service.category,
                          departmentId: service.departmentId,
                          description: service.description,
                          durationMinutes: service.durationMinutes,
                          price: Number(service.price),
                          billable: service.billable,
                          isActive: service.isActive,
                          requiredRoomType: service.requiredRoomType,
                          providers: service.providers.map((sp) => ({ providerId: sp.providerId })),
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
  )
}
