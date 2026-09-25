import Link from "next/link"
import { getOrganizationCommercialDetail } from "@/lib/domains/commercial/organizations"
import { listPilotUats } from "@/lib/domains/commercial/pilot-uat"
import { requirePlatformOperator } from "@/lib/platform/operator-guard"
import { loadOrNotFound } from "@/lib/platform/not-found"
import { DetailHeader } from "@/components/ui/page-header"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { StatusBadge } from "@/components/ui/status-badge"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { formatDateTime } from "@/lib/utils/dates"
import { NewUatCycleDialog, AddScenarioDialog, CompleteUatDialog } from "@/app/platform/organizations/[id]/uat/uat-dialogs"
import { PlatformPageShell } from "@/components/layout/platform-page-shell"

/**
 * P5.2 §11: a repeatable pilot checklist — never a clinical claim or a
 * regulatory certification. This page and its data model record that a
 * real operational walkthrough happened and what it found, nothing more.
 */
export default async function PilotUatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requirePlatformOperator()
  const [{ organization }, uats] = await Promise.all([loadOrNotFound(() => getOrganizationCommercialDetail(id)), listPilotUats(id)])

  return (
    <PlatformPageShell>
      <div className="flex flex-col gap-6">
        <DetailHeader
          module="platform"
          title={`Pilot UAT — ${organization.displayName}`}
          meta="Repeatable operational walkthrough evidence — not a clinical claim or regulatory certification."
          actions={
            <div className="flex gap-2">
              <Button asChild size="sm" variant="outline">
                <Link href={`/platform/organizations/${organization.id}`}>Back to organization</Link>
              </Button>
              <NewUatCycleDialog organizationId={organization.id} />
            </div>
          }
        />

        {uats.length === 0 && <EmptyState title="No UAT cycles yet" description="Start the first pilot UAT cycle for this clinic." />}

        {uats.map((uat) => (
          <Card key={uat.id}>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="text-base">{uat.cycleLabel}</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Tester: {uat.testerName} · Started {uat.startedAt ? formatDateTime(uat.startedAt) : "—"}
                  {uat.completedAt && ` · Completed ${formatDateTime(uat.completedAt)}`}
                  {uat.signedOffAt && ` · Signed off ${formatDateTime(uat.signedOffAt)}`}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge status={uat.result} />
                <AddScenarioDialog organizationId={organization.id} uatId={uat.id} />
                <CompleteUatDialog organizationId={organization.id} uatId={uat.id} />
              </div>
            </CardHeader>
            <CardContent className="grid gap-2">
              {uat.blockers && (
                <p className="text-sm text-destructive">
                  <strong>Blockers:</strong> {uat.blockers}
                </p>
              )}
              {uat.notes && <p className="text-sm text-muted-foreground">{uat.notes}</p>}
              {uat.scenarios.length === 0 ? (
                <p className="text-sm text-muted-foreground">No scenario results recorded yet.</p>
              ) : (
                <div className="grid gap-1">
                  {uat.scenarios.map((s) => (
                    <div key={s.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2 text-sm">
                      <span className="w-28 shrink-0 text-xs uppercase text-muted-foreground">{s.area.replace(/_/g, " ")}</span>
                      <span className="flex-1">{s.scenario}</span>
                      <span className={s.passed === true ? "text-success" : s.passed === false ? "text-destructive" : "text-muted-foreground"}>
                        {s.passed === true ? "Passed" : s.passed === false ? "Failed" : "Not yet run"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </PlatformPageShell>
  )
}
