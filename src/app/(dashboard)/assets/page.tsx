import Link from "next/link"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listAssets, listAssetAlerts } from "@/lib/domains/assets/assets"
import { listEmployeeDirectory } from "@/lib/domains/hr/employees"
import { listAccessibleBranches } from "@/lib/domains/billing/cashier"
import { listDepartments } from "@/lib/domains/identity/org-structure"
import { listSuppliers } from "@/lib/domains/procurement/suppliers"
import { formatDate } from "@/lib/utils/dates"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AssetDialog } from "@/app/(dashboard)/assets/asset-dialog"

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  available: "default",
  in_use: "secondary",
  maintenance: "outline",
  damaged: "destructive",
  lost: "destructive",
  retired: "outline",
  disposed: "outline",
}

export default async function AssetsPage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "inventory.view")) redirect("/dashboard")

  const canManage = can(session, "asset.manage")
  const canViewSuppliers = can(session, "supplier.view")

  const [assets, alerts, branches, departments, employees, suppliers] = await Promise.all([
    listAssets(session),
    listAssetAlerts(session),
    listAccessibleBranches(session),
    listDepartments(session).catch(() => []),
    listEmployeeDirectory(session),
    canViewSuppliers ? listSuppliers(session) : Promise.resolve([]),
  ])

  const branchOptions = branches.map((b) => ({ id: b.id, name: b.name }))
  const departmentOptions = departments.map((d) => ({ id: d.id, name: d.name }))
  const employeeOptions = employees
  const supplierOptions = suppliers.map((s) => ({ id: s.id, companyName: s.companyName }))

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Assets</h1>
          <p className="text-sm text-muted-foreground">{assets.length} asset(s)</p>
        </div>
        {canManage && <AssetDialog branches={branchOptions} departments={departmentOptions} employees={employeeOptions} suppliers={supplierOptions} />}
      </div>

      <Tabs defaultValue="all">
        <TabsList>
          <TabsTrigger value="all">All Assets</TabsTrigger>
          <TabsTrigger value="alerts">
            Alerts {alerts.warrantyExpiring.length + alerts.calibrationDue.length > 0 && `(${alerts.warrantyExpiring.length + alerts.calibrationDue.length})`}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="all" className="grid gap-4">
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Branch</TableHead>
                    <TableHead>Assigned to</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {assets.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-muted-foreground">
                        No assets yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {assets.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="font-medium">
                        <Link href={`/assets/${a.id}`} className="hover:underline">
                          {a.assetNumber}
                        </Link>
                      </TableCell>
                      <TableCell>{a.name}</TableCell>
                      <TableCell>{a.category}</TableCell>
                      <TableCell>{a.branch.name}</TableCell>
                      <TableCell>{a.assignedEmployee ? `${a.assignedEmployee.firstName} ${a.assignedEmployee.lastName}` : "—"}</TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[a.status] ?? "outline"}>{a.status.replace("_", " ")}</Badge>
                      </TableCell>
                      <TableCell>
                        {canManage && (
                          <AssetDialog
                            branches={branchOptions}
                            departments={departmentOptions}
                            employees={employeeOptions}
                            suppliers={supplierOptions}
                            existing={{
                              id: a.id,
                              branchId: a.branchId,
                              departmentId: a.departmentId,
                              barcode: a.barcode,
                              name: a.name,
                              category: a.category,
                              manufacturer: a.manufacturer,
                              model: a.model,
                              serialNumber: a.serialNumber,
                              assignedEmployeeId: a.assignedEmployeeId,
                              supplierId: a.supplierId,
                              purchaseDate: a.purchaseDate ? a.purchaseDate.toISOString().slice(0, 10) : null,
                              cost: a.cost != null ? Number(a.cost) : null,
                              paidVia: a.paidVia,
                              warrantyExpiryDate: a.warrantyExpiryDate ? a.warrantyExpiryDate.toISOString().slice(0, 10) : null,
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

        <TabsContent value="alerts" className="grid gap-4">
          <Card>
            <CardContent className="grid gap-6 pt-6">
              <div>
                <h3 className="mb-2 text-sm font-medium">Warranty expiring (next 30 days)</h3>
                {alerts.warrantyExpiring.length === 0 && <p className="text-sm text-muted-foreground">Nothing expiring soon.</p>}
                {alerts.warrantyExpiring.map((a) => (
                  <div key={a.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                    <Link href={`/assets/${a.id}`} className="hover:underline">
                      {a.assetNumber} — {a.name}
                    </Link>
                    <span className="text-muted-foreground">{a.warrantyExpiryDate ? formatDate(a.warrantyExpiryDate) : "—"}</span>
                  </div>
                ))}
              </div>
              <div>
                <h3 className="mb-2 text-sm font-medium">Calibration due (next 30 days)</h3>
                {alerts.calibrationDue.length === 0 && <p className="text-sm text-muted-foreground">Nothing due soon.</p>}
                {alerts.calibrationDue.map((c) => (
                  <div key={c.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                    <Link href={`/assets/${c.assetId}`} className="hover:underline">
                      {c.asset.assetNumber} — {c.asset.name}
                    </Link>
                    <span className="text-muted-foreground">{c.nextCalibrationDate ? formatDate(c.nextCalibrationDate) : "—"}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
