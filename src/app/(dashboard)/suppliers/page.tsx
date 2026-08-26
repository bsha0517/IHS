import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listSuppliers } from "@/lib/domains/procurement/suppliers"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { SupplierDialog } from "@/app/(dashboard)/suppliers/supplier-dialog"

export default async function SuppliersPage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "supplier.view")) redirect("/dashboard")

  const suppliers = await listSuppliers(session)
  const canManage = can(session, "supplier.manage")

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Suppliers</h1>
          <p className="text-sm text-muted-foreground">{suppliers.length} supplier(s)</p>
        </div>
        {canManage && <SupplierDialog />}
      </div>

      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Payment terms</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {suppliers.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    No suppliers yet.
                  </TableCell>
                </TableRow>
              )}
              {suppliers.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.code}</TableCell>
                  <TableCell>{s.companyName}</TableCell>
                  <TableCell>{s.contactName ?? "—"}</TableCell>
                  <TableCell>{s.phone ?? "—"}</TableCell>
                  <TableCell>{s.paymentTerms ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={s.status === "active" ? "default" : "secondary"}>{s.status}</Badge>
                  </TableCell>
                  <TableCell>
                    {canManage && (
                      <SupplierDialog
                        existing={{
                          id: s.id,
                          code: s.code,
                          companyName: s.companyName,
                          contactName: s.contactName,
                          phone: s.phone,
                          email: s.email,
                          address: s.address,
                          taxNumber: s.taxNumber,
                          paymentTerms: s.paymentTerms,
                          bankDetails: s.bankDetails,
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
