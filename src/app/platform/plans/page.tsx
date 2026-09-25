import { listPlans } from "@/lib/domains/commercial/plans"
import { PageHeader } from "@/components/ui/page-header"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/empty-state"
import { MODULE_LABELS, type ModuleKey } from "@/lib/platform/entitlements-shared"
import { PlanDialog } from "@/app/platform/plans/plan-dialog"
import { PlatformPageShell } from "@/components/layout/platform-page-shell"

export default async function PlatformPlansPage() {
  const plans = await listPlans()

  return (
    <PlatformPageShell>
    <div className="flex flex-col gap-6">
      <PageHeader title="Commercial Plans" module="platform" description={`${plans.length} plan(s)`} primaryAction={<PlanDialog />} />

      <Card>
        <CardContent className="pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">User limit</TableHead>
                <TableHead className="text-right">Branch limit</TableHead>
                <TableHead>Default modules</TableHead>
                <TableHead>Active</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {plans.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="p-0">
                    <EmptyState title="No plans yet" description="Create Starter/Professional/Enterprise (or your own) before provisioning a clinic." className="border-none" />
                  </TableCell>
                </TableRow>
              )}
              {plans.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-mono text-xs">{p.code}</TableCell>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.userLimit ?? "Unlimited"}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.branchLimit ?? "Unlimited"}</TableCell>
                  <TableCell className="max-w-xs">
                    <div className="flex flex-wrap gap-1">
                      {p.defaultModuleKeys.map((key) => (
                        <Badge key={key} variant="outline" className="text-[10px]">
                          {MODULE_LABELS[key as ModuleKey] ?? key}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={p.active ? "success" : "neutral"}>{p.active ? "Active" : "Inactive"}</Badge>
                  </TableCell>
                  <TableCell>
                    <PlanDialog
                      plan={{
                        id: p.id,
                        code: p.code,
                        name: p.name,
                        description: p.description,
                        active: p.active,
                        userLimit: p.userLimit,
                        branchLimit: p.branchLimit,
                        defaultModuleKeys: p.defaultModuleKeys,
                        notes: p.notes,
                      }}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
    </PlatformPageShell>
  )
}
