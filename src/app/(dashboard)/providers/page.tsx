import Link from "next/link"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listProviders } from "@/lib/domains/providers/service"
import { listBranches, listDepartments } from "@/lib/domains/identity/org-structure"
import { listUsers } from "@/lib/domains/identity/users"
import { Card, CardContent } from "@/components/ui/card"
import { PageHeader } from "@/components/ui/page-header"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { NewProviderDialog } from "@/app/(dashboard)/providers/new-provider-dialog"

export default async function ProvidersPage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "provider.view")) redirect("/dashboard")

  const [providers, branches, departments, users] = await Promise.all([
    listProviders(session),
    listBranches(session),
    listDepartments(session),
    can(session, "users.manage") ? listUsers(session) : Promise.resolve([]),
  ])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Providers"
        module="clinical"
        description={`${providers.length} provider(s)`}
        primaryAction={can(session, "provider.manage") && <NewProviderDialog branches={branches} departments={departments} users={users} />}
      />

      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Specialty</TableHead>
                <TableHead>Branches</TableHead>
                <TableHead>Fee</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    No providers yet.
                  </TableCell>
                </TableRow>
              )}
              {providers.map((provider) => (
                <TableRow key={provider.id}>
                  <TableCell>
                    <Link href={`/providers/${provider.id}`} className="font-medium hover:underline">
                      {provider.firstName} {provider.lastName}
                    </Link>
                  </TableCell>
                  <TableCell className="capitalize">{provider.providerType}</TableCell>
                  <TableCell>{provider.specialty ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {provider.branches.map((b) => b.branch.name).join(", ") || "—"}
                  </TableCell>
                  <TableCell>{Number(provider.consultationFee).toFixed(2)}</TableCell>
                  <TableCell>
                    <Badge variant={provider.status === "active" ? "default" : "secondary"}>{provider.status}</Badge>
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
