import Link from "next/link"
import { getImplementationWorkspace } from "@/lib/domains/commercial/implementation"
import { getCountryPack } from "@/lib/domains/commercial/country-packs-shared"
import { loadOrNotFound } from "@/lib/platform/not-found"
import { DetailHeader } from "@/components/ui/page-header"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { formatDate } from "@/lib/utils/dates"
import { PlatformPageShell } from "@/components/layout/platform-page-shell"
import { GoLiveApprovalCard } from "@/app/platform/organizations/[id]/go-live-approval-card"
import { StageStatusBadge, SeverityBadge } from "@/app/platform/organizations/[id]/implementation/stage-status-badge"
import { SummaryEditDialog } from "@/app/platform/organizations/[id]/implementation/summary-edit-dialog"
import { TrainingCard } from "@/app/platform/organizations/[id]/implementation/training-card"
import { NotesCard } from "@/app/platform/organizations/[id]/implementation/notes-card"
import { HandoverCard } from "@/app/platform/organizations/[id]/implementation/handover-card"

const SUMMARY_STATUS_LABEL: Record<string, string> = {
  not_started: "Not Started",
  in_progress: "In Progress",
  blocked: "Blocked",
  live_pending_handover: "Live — Handover Pending",
  complete: "Complete",
}

/**
 * P5.8 — one coherent per-customer implementation workspace, composing
 * (never duplicating) the existing onboarding/UAT/support/go-live/financial
 * readiness domains via `getImplementationWorkspace()`. See that function's
 * own doc comment for exactly what's reused vs. genuinely new.
 */
export default async function ImplementationWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const workspace = await loadOrNotFound(() => getImplementationWorkspace(id))
  const { detail, stages, blockers, summary, training, notes, pilotUats, tickets, operatorEmails } = workspace
  const { organization } = detail
  const profile = organization.commercialProfile!
  const countryPack = getCountryPack(profile.country)

  return (
    <PlatformPageShell>
      <div className="flex flex-col gap-6">
        <DetailHeader
          module="platform"
          title={organization.displayName}
          meta={
            <>
              {profile.customerCode} · {profile.country}
              {countryPack ? ` (${countryPack.countryName})` : ""} · {detail.usage.planName ?? "No plan"} ·{" "}
              {detail.activeBranchCount} branch(es) · {detail.activeUserCount} user(s) · {detail.usage.enabledModuleCount}/{detail.usage.totalModuleCount} modules
            </>
          }
          badge={<Badge variant={summary.status === "blocked" ? "destructive" : summary.status === "complete" ? "success" : "info"}>{SUMMARY_STATUS_LABEL[summary.status]}</Badge>}
          actions={
            <Button asChild size="sm" variant="outline">
              <Link href={`/platform/organizations/${organization.id}`}>Commercial summary</Link>
            </Button>
          }
        />

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-base">Implementation summary</CardTitle>
            <SummaryEditDialog organizationId={organization.id} targetGoLiveDate={profile.targetGoLiveDate} implementationOwner={profile.implementationOwner} />
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-5">
            <SummaryStat label="Target go-live" value={profile.targetGoLiveDate ? formatDate(profile.targetGoLiveDate) : "Not set"} />
            <SummaryStat label="Implementation owner" value={profile.implementationOwner ?? "Unassigned"} />
            <SummaryStat label="Stages complete" value={`${summary.completedStageCount} / ${summary.totalStageCount}`} />
            <SummaryStat label="Blocking issues" value={String(summary.blockingCount)} tone={summary.blockingCount > 0 ? "destructive" : undefined} />
            <SummaryStat label="Next action" value={summary.nextAction ?? "None — everything visible here is complete"} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Implementation blockers</CardTitle>
          </CardHeader>
          <CardContent>
            {blockers.length === 0 ? (
              <EmptyState title="No blockers or warnings" description="Every readiness signal this workspace tracks is currently clear." className="border-none" />
            ) : (
              <div className="grid gap-2">
                {blockers.map((b, i) => (
                  <div key={i} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2 text-sm">
                    <div className="flex items-center gap-2">
                      <SeverityBadge severity={b.severity} />
                      <span>{b.message}</span>
                    </div>
                    {b.nextActionHref && (
                      <Button asChild size="sm" variant="outline">
                        <Link href={b.nextActionHref}>{b.nextActionLabel ?? "Resolve"}</Link>
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Implementation stages</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            {stages.map((stage) => (
              <div key={stage.key} className="rounded-md border border-border p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{stage.label}</span>
                  <StageStatusBadge status={stage.status} />
                </div>
                <ul className="grid gap-1 text-sm">
                  {stage.items.map((item, i) => (
                    <li key={i} className="flex items-start justify-between gap-2">
                      <span className={item.complete ? "text-muted-foreground line-through" : ""}>
                        {item.label}
                        {item.note && <span className="ml-1 text-xs text-muted-foreground no-underline">— {item.note}</span>}
                      </span>
                      {item.href && !item.complete && (
                        <Link href={item.href} className="shrink-0 text-xs text-primary underline-offset-2 hover:underline">
                          Go to page
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </CardContent>
        </Card>

        <TrainingCard organizationId={organization.id} training={training} />

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-base">UAT</CardTitle>
            <Button asChild size="sm" variant="outline">
              <Link href={`/platform/organizations/${organization.id}/uat`}>Open UAT workspace</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {pilotUats.length === 0 ? (
              <EmptyState title="No UAT cycles recorded yet" className="border-none" />
            ) : (
              <div className="grid gap-2 text-sm">
                {pilotUats.map((u) => (
                  <div key={u.id} className="flex items-center justify-between rounded-md border border-border p-2">
                    <span>{u.cycleLabel}</span>
                    <span className="text-muted-foreground">
                      {u.scenarios.filter((s) => s.passed === true).length}/{u.scenarios.length} passed · {u.result.replace(/_/g, " ")}
                      {u.signedOffAt ? " · signed off" : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-base">Support tickets</CardTitle>
            <Button asChild size="sm" variant="outline">
              <Link href={`/platform/tickets?organizationId=${organization.id}`}>Open support tickets</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {tickets.length === 0 ? (
              <EmptyState title="No support tickets for this organization" className="border-none" />
            ) : (
              <div className="grid gap-2 text-sm">
                {tickets.slice(0, 5).map((t) => (
                  <div key={t.id} className="flex items-center justify-between rounded-md border border-border p-2">
                    <span>
                      {t.ticketNumber} — {t.title}
                    </span>
                    <span className="text-muted-foreground">
                      {t.priority} · {t.status.replace(/_/g, " ")}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <NotesCard organizationId={organization.id} notes={notes} operatorEmails={operatorEmails} />

        <div id="go-live">
          <GoLiveApprovalCard organizationId={organization.id} blockers={detail.goLiveBlockers} alreadyLive={profile.commercialLifecycle === "live"} />
        </div>

        <HandoverCard
          organizationId={organization.id}
          alreadyLive={profile.commercialLifecycle === "live"}
          alreadyCompleted={Boolean(profile.handoverCompletedAt)}
          completedAt={profile.handoverCompletedAt}
          completedByEmail={profile.handoverCompletedByOperatorId ? (operatorEmails[profile.handoverCompletedByOperatorId] ?? null) : null}
          canComplete={summary.blockingCount === 0}
        />
      </div>
    </PlatformPageShell>
  )
}

function SummaryStat({ label, value, tone }: { label: string; value: string; tone?: "destructive" }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-sm font-medium ${tone === "destructive" ? "text-destructive" : ""}`}>{value}</div>
    </div>
  )
}
