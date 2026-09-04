import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listCommissionRules, getProviderStatement } from "@/lib/domains/payroll/commissions"
import { listProviders } from "@/lib/domains/providers/service"
import { listServices } from "@/lib/domains/services/service"
import { formatDateTime } from "@/lib/utils/dates"
import { Card, CardContent } from "@/components/ui/card"
import { PageHeader } from "@/components/ui/page-header"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CommissionRuleDialog } from "@/app/(dashboard)/commissions/commission-rule-dialog"

export default async function CommissionsPage({ searchParams }: { searchParams: Promise<{ providerId?: string }> }) {
  const session = await getCurrentSession()
  if (!session || !can(session, "payroll.view")) redirect("/dashboard")

  const canManage = can(session, "commission.manage")
  const { providerId } = await searchParams

  const [rules, providers, services] = await Promise.all([
    listCommissionRules(session),
    listProviders(session),
    listServices(session),
  ])
  const statement = providerId ? await getProviderStatement(session, providerId) : null

  const providerOptions = providers.map((p) => ({ id: p.id, firstName: p.firstName, lastName: p.lastName }))
  const serviceOptions = services.map((s) => ({ id: s.id, name: s.name }))

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Commissions" />

      <Tabs defaultValue="rules">
        <TabsList>
          <TabsTrigger value="rules">Rules</TabsTrigger>
          <TabsTrigger value="statements">Provider Statements</TabsTrigger>
        </TabsList>

        <TabsContent value="rules" className="grid gap-4">
          {canManage && (
            <div className="flex justify-end">
              <CommissionRuleDialog providers={providerOptions} services={serviceOptions} />
            </div>
          )}
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Provider</TableHead>
                    <TableHead>Service</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Basis</TableHead>
                    <TableHead>Rate</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rules.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground">
                        No commission rules configured.
                      </TableCell>
                    </TableRow>
                  )}
                  {rules.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{r.provider ? `${r.provider.firstName} ${r.provider.lastName}` : <Badge variant="outline">all providers</Badge>}</TableCell>
                      <TableCell>{r.service ? r.service.name : <Badge variant="outline">all services</Badge>}</TableCell>
                      <TableCell className="capitalize">{r.type}</TableCell>
                      <TableCell className="capitalize">{r.basis.replace(/_/g, " ")}</TableCell>
                      <TableCell>
                        {r.type === "fixed" && Number(r.fixedAmount).toFixed(2)}
                        {r.type === "percentage" && `${(Number(r.percentageRate) * 100).toFixed(1)}%`}
                        {r.type === "tiered" && "tiered"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={r.isActive ? "default" : "secondary"}>{r.isActive ? "active" : "inactive"}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="statements" className="grid gap-4">
          <form method="get" className="flex items-end gap-2">
            <div className="grid gap-2">
              <label htmlFor="providerId" className="text-sm text-muted-foreground">
                Provider
              </label>
              <select id="providerId" name="providerId" defaultValue={providerId ?? ""} className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm">
                <option value="">Select a provider</option>
                {providerOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.firstName} {p.lastName}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="h-8 rounded-lg border border-input px-3 text-sm">
              View statement
            </button>
          </form>

          {statement && (
            <Card>
              <CardContent className="pt-6">
                <p className="mb-4 text-sm text-muted-foreground">Total: {statement.total.toFixed(2)}</p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Charge</TableHead>
                      <TableHead>Basis amount</TableHead>
                      <TableHead className="text-right">Commission</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {statement.accruals.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center text-muted-foreground">
                          No commission accruals for this provider.
                        </TableCell>
                      </TableRow>
                    )}
                    {statement.accruals.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell>{formatDateTime(a.accruedAt)}</TableCell>
                        <TableCell>{a.charge.description}</TableCell>
                        <TableCell>{Number(a.basisAmount).toFixed(2)}</TableCell>
                        <TableCell className="text-right">{Number(a.amount).toFixed(2)}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{a.status.replace(/_/g, " ")}</Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
