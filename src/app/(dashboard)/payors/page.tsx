import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listPayors } from "@/lib/domains/claims/payors"
import { Card, CardContent } from "@/components/ui/card"
import { PageHeader } from "@/components/ui/page-header"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PayorDialog } from "@/app/(dashboard)/payors/payor-dialog"
import { PlanDialog } from "@/app/(dashboard)/payors/plan-dialog"
import { PolicyDialog } from "@/app/(dashboard)/payors/policy-dialog"

const PAYOR_TYPE_LABEL: Record<string, string> = {
  self_pay: "Self Pay",
  insurance_company: "Insurance Company",
  corporate: "Corporate",
  government: "Government",
  other: "Other",
}

export default async function PayorsPage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "payor.manage")) redirect("/dashboard")

  const payors = await listPayors(session)
  const payorOptions = payors.map((p) => ({ id: p.id, name: p.name }))
  const plans = payors.flatMap((p) => p.insurancePlans.map((plan) => ({ ...plan, payorName: p.name })))
  const planOptions = plans.map((p) => ({ id: p.id, label: `${p.payorName} — ${p.name}` }))
  const policies = plans.flatMap((plan) => plan.policies.map((policy) => ({ ...policy, planName: plan.name, payorName: plan.payorName })))

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Payors" />

      <Tabs defaultValue="payors">
        <TabsList>
          <TabsTrigger value="payors">Payors</TabsTrigger>
          <TabsTrigger value="plans">Insurance Plans</TabsTrigger>
          <TabsTrigger value="policies">Policies</TabsTrigger>
        </TabsList>

        <TabsContent value="payors" className="grid gap-4">
          <div className="flex justify-end">
            <PayorDialog />
          </div>
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Contact</TableHead>
                    <TableHead>Plans</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payors.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground">
                        No payors yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {payors.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">{p.code}</TableCell>
                      <TableCell>{p.name}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{PAYOR_TYPE_LABEL[p.payorType] ?? p.payorType}</Badge>
                      </TableCell>
                      <TableCell>{p.contactPhone ?? p.contactEmail ?? "—"}</TableCell>
                      <TableCell>{p.insurancePlans.length}</TableCell>
                      <TableCell>
                        <PayorDialog
                          existing={{
                            id: p.id,
                            code: p.code,
                            name: p.name,
                            payorType: p.payorType,
                            contactName: p.contactName,
                            contactPhone: p.contactPhone,
                            contactEmail: p.contactEmail,
                            address: p.address,
                          }}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="plans" className="grid gap-4">
          <div className="flex justify-end">
            <PlanDialog payors={payorOptions} />
          </div>
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Payor</TableHead>
                    <TableHead>Policies</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {plans.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground">
                        No insurance plans yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {plans.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">{p.code}</TableCell>
                      <TableCell>{p.name}</TableCell>
                      <TableCell>{p.payorName}</TableCell>
                      <TableCell>{p.policies.length}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="policies" className="grid gap-4">
          <div className="flex justify-end">
            <PolicyDialog plans={planOptions} />
          </div>
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Policy #</TableHead>
                    <TableHead>Group #</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>Payor</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {policies.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground">
                        No policies yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {policies.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">{p.policyNumber}</TableCell>
                      <TableCell>{p.groupNumber ?? "—"}</TableCell>
                      <TableCell>{p.planName}</TableCell>
                      <TableCell>{p.payorName}</TableCell>
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
