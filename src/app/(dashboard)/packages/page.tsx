import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listPackages } from "@/lib/domains/packages/service"
import { listServices } from "@/lib/domains/services/service"
import { Card, CardContent } from "@/components/ui/card"
import { PageHeader } from "@/components/ui/page-header"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { NewPackageDialog } from "@/app/(dashboard)/packages/package-dialog"

export default async function PackagesPage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "service.view")) redirect("/dashboard")

  const [packages, services] = await Promise.all([listPackages(session), listServices(session)])
  const canManage = can(session, "package.manage")
  const serviceOptions = services.map((s) => ({ id: s.id, name: s.name }))

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Packages"
        description={`${packages.length} package(s)`}
        primaryAction={canManage && <NewPackageDialog services={serviceOptions} />}
      />

      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Services</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Validity</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {packages.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    No packages yet.
                  </TableCell>
                </TableRow>
              )}
              {packages.map((pkg) => (
                <TableRow key={pkg.id}>
                  <TableCell className="font-medium">{pkg.code}</TableCell>
                  <TableCell>{pkg.name}</TableCell>
                  <TableCell>
                    {pkg.services.map((ps) => `${ps.service.name} (${ps.sessionsAllocated})`).join(", ")}
                  </TableCell>
                  <TableCell>{Number(pkg.price).toFixed(2)}</TableCell>
                  <TableCell>{pkg.validityDays ? `${pkg.validityDays} days` : "No expiry"}</TableCell>
                  <TableCell>
                    <Badge variant={pkg.isActive ? "default" : "secondary"}>{pkg.isActive ? "active" : "inactive"}</Badge>
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
