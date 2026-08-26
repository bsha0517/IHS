import { TabsContent } from "@/components/ui/tabs"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { formatDate } from "@/lib/utils/dates"
import { can } from "@/lib/platform/permissions-core"
import { listPatientCoverage, listPatientAuthorizations } from "@/lib/domains/claims/coverage"
import { listPayors } from "@/lib/domains/claims/payors"
import type { SessionContext } from "@/lib/auth/session"
import { AddCoverageDialog } from "@/app/(dashboard)/patients/[id]/add-coverage-dialog"
import { DeactivateCoverageButton } from "@/app/(dashboard)/patients/[id]/coverage-actions"
import { RequestAuthorizationDialog, DecideAuthorizationDialog } from "@/app/(dashboard)/patients/[id]/authorization-actions"

const AUTH_STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  requested: "outline",
  approved: "default",
  denied: "destructive",
  expired: "secondary",
}

export async function InsuranceTabs({ session, patientId }: { session: SessionContext; patientId: string }) {
  const canManageCoverage = can(session, "coverage.manage")
  if (!canManageCoverage) {
    return (
      <TabsContent value="insurance">
        <p className="text-sm text-muted-foreground">You don&apos;t have permission to view insurance coverage.</p>
      </TabsContent>
    )
  }

  const [coverages, authorizations, payors] = await Promise.all([
    listPatientCoverage(session, patientId),
    listPatientAuthorizations(session, patientId),
    listPayors(session),
  ])

  const policyOptions = payors.flatMap((payor) =>
    payor.insurancePlans.flatMap((plan) =>
      plan.policies.map((policy) => ({ id: policy.id, label: `${payor.name} — ${plan.name} — ${policy.policyNumber}` }))
    )
  )
  const coverageOptions = coverages
    .filter((c) => c.status === "active")
    .map((c) => ({ id: c.id, label: `${c.policy.insurancePlan.payor.name} — ${c.policy.insurancePlan.name} (${c.memberId})` }))

  return (
    <TabsContent value="insurance" className="grid gap-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Coverage</CardTitle>
          <AddCoverageDialog patientId={patientId} policies={policyOptions} />
        </CardHeader>
        <CardContent className="grid gap-2">
          {coverages.length === 0 && <p className="text-sm text-muted-foreground">No insurance coverage on file.</p>}
          {coverages.map((c) => (
            <div key={c.id} className="rounded-md border border-border p-3 text-sm">
              <div className="flex items-center justify-between">
                <p className="font-medium">
                  {c.policy.insurancePlan.payor.name} — {c.policy.insurancePlan.name}
                </p>
                <div className="flex items-center gap-2">
                  {c.isPrimary && <Badge variant="outline">Primary</Badge>}
                  <Badge variant={c.status === "active" ? "default" : "secondary"}>{c.status}</Badge>
                  {c.status === "active" && <DeactivateCoverageButton coverageId={c.id} patientId={patientId} />}
                </div>
              </div>
              <p className="text-muted-foreground">
                Member {c.memberId} · Policy {c.policy.policyNumber} · {formatDate(c.startDate)}
                {c.endDate ? ` – ${formatDate(c.endDate)}` : ""}
              </p>
              {(c.copayAmount != null || c.copayPercent != null || c.deductibleAmount != null) && (
                <p className="text-muted-foreground">
                  {c.copayAmount != null && `Copay ${Number(c.copayAmount).toFixed(2)}`}
                  {c.copayPercent != null && `Copay ${Number(c.copayPercent)}%`}
                  {c.deductibleAmount != null && ` · Deductible ${Number(c.deductibleAmount).toFixed(2)}`}
                </p>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Prior authorizations</CardTitle>
          {coverageOptions.length > 0 && <RequestAuthorizationDialog patientId={patientId} coverages={coverageOptions} />}
        </CardHeader>
        <CardContent className="pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Coverage</TableHead>
                <TableHead>Requested</TableHead>
                <TableHead>Auth #</TableHead>
                <TableHead>Valid</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {authorizations.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    No authorizations requested.
                  </TableCell>
                </TableRow>
              )}
              {authorizations.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>{a.patientCoverage.policy.insurancePlan.payor.name}</TableCell>
                  <TableCell>{formatDate(a.requestedAt)}</TableCell>
                  <TableCell>{a.authNumber ?? "—"}</TableCell>
                  <TableCell>
                    {a.validFrom && a.validUntil ? `${formatDate(a.validFrom)} – ${formatDate(a.validUntil)}` : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={AUTH_STATUS_VARIANT[a.status] ?? "outline"}>{a.status}</Badge>
                  </TableCell>
                  <TableCell className="flex justify-end gap-2">
                    {a.status === "requested" && (
                      <>
                        <DecideAuthorizationDialog authorizationId={a.id} patientId={patientId} decision="approve" />
                        <DecideAuthorizationDialog authorizationId={a.id} patientId={patientId} decision="deny" />
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </TabsContent>
  )
}
