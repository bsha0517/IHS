import Link from "next/link"
import { getOrganizationCommercialDetail } from "@/lib/domains/commercial/organizations"
import { listOnboardingChecklist } from "@/lib/domains/commercial/onboarding-checklist"
import { requirePlatformOperator } from "@/lib/platform/operator-guard"
import { loadOrNotFound } from "@/lib/platform/not-found"
import { DetailHeader } from "@/components/ui/page-header"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { StatusBadge } from "@/components/ui/status-badge"
import { Button } from "@/components/ui/button"
import { formatDate } from "@/lib/utils/dates"
import { ChecklistItemDialog } from "@/app/platform/organizations/[id]/onboarding/checklist-item-dialog"
import { PlatformPageShell } from "@/components/layout/platform-page-shell"

const CATEGORY_LABELS: Record<string, string> = {
  organization: "Organization",
  branches: "Branches",
  users: "Users",
  operational_configuration: "Operational configuration",
}
const CATEGORY_ORDER = ["organization", "branches", "users", "operational_configuration"]

export default async function OnboardingWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const operator = await requirePlatformOperator()
  const [{ organization }, items] = await Promise.all([
    loadOrNotFound(() => getOrganizationCommercialDetail(id)),
    listOnboardingChecklist(id, operator.operator.id),
  ])

  const byCategory = new Map<string, typeof items>()
  for (const item of items) {
    const list = byCategory.get(item.category) ?? []
    list.push(item)
    byCategory.set(item.category, list)
  }

  const required = items.filter((i) => i.required)
  const requiredComplete = required.filter((i) => i.status === "completed" || i.status === "waived")

  return (
    <PlatformPageShell>
      <div className="flex flex-col gap-6">
        <DetailHeader
          module="platform"
          title={`Onboarding — ${organization.displayName}`}
          meta={
            <>
              {requiredComplete.length} / {required.length} required items complete
            </>
          }
          actions={
            <Button asChild size="sm" variant="outline">
              <Link href={`/platform/organizations/${organization.id}`}>Back to organization</Link>
            </Button>
          }
        />

        {CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((category) => (
          <Card key={category}>
            <CardHeader>
              <CardTitle className="text-base">{CATEGORY_LABELS[category] ?? category}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2">
              {(byCategory.get(category) ?? []).map((item) => (
                <div key={item.id} className="grid gap-2 rounded-md border border-border p-3 text-sm sm:grid-cols-[1fr_auto] sm:items-start sm:gap-4">
                  <div className="grid gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{item.label}</span>
                      {item.required && (
                        <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">Required</span>
                      )}
                      <StatusBadge status={item.status} />
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                      {item.ownerLabel && <span>Owner: {item.ownerLabel}</span>}
                      {item.dueDate && <span>Due: {formatDate(item.dueDate)}</span>}
                      {item.completedAt && <span>Completed: {formatDate(item.completedAt)}</span>}
                    </div>
                    {item.notes && <p className="text-xs text-muted-foreground">{item.notes}</p>}
                    {item.evidenceReference && <p className="text-xs text-muted-foreground">Evidence: {item.evidenceReference}</p>}
                  </div>
                  <ChecklistItemDialog organizationId={organization.id} item={item} />
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </PlatformPageShell>
  )
}
