import Link from "next/link"
import { getOrganizationCommercialDetail } from "@/lib/domains/commercial/organizations"
import { listPlans } from "@/lib/domains/commercial/plans"
import { getRegulatoryIntegrations } from "@/lib/domains/commercial/regulatory"
import { loadOrNotFound } from "@/lib/platform/not-found"
import { DetailHeader } from "@/components/ui/page-header"
import { StatusBadge } from "@/components/ui/status-badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { EmptyState } from "@/components/ui/empty-state"
import { Button } from "@/components/ui/button"
import { formatDate, formatDateTime } from "@/lib/utils/dates"
import { CommercialProfileDialog } from "@/app/platform/organizations/[id]/commercial-profile-dialog"
import { SubscriptionDialog } from "@/app/platform/organizations/[id]/subscription-dialog"
import { EntitlementsCard } from "@/app/platform/organizations/[id]/entitlements-card"
import { OnboardingCard } from "@/app/platform/organizations/[id]/onboarding-card"
import { GoLiveConditionsCard } from "@/app/platform/organizations/[id]/go-live-conditions-card"
import { GoLiveApprovalCard } from "@/app/platform/organizations/[id]/go-live-approval-card"
import { RegulatoryCard } from "@/app/platform/organizations/[id]/regulatory-card"
import { LifecycleActions } from "@/app/platform/organizations/[id]/lifecycle-actions"
import { PlatformPageShell } from "@/components/layout/platform-page-shell"
import { getCountryPack } from "@/lib/domains/commercial/country-packs-shared"
import type { ModuleKey } from "@/lib/platform/entitlements-shared"

export default async function PlatformOrganizationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [
    { organization, admins, activeBranchCount, activeUserCount, entitlements, recentAudit, usage, checklistSummary, goLiveBlockers, openTicketCount, operatorEmails },
    plans,
  ] = await Promise.all([loadOrNotFound(() => getOrganizationCommercialDetail(id)), listPlans()])

  const profile = organization.commercialProfile
  const currentSubscription = profile?.subscriptions[0] ?? null
  const regulatoryIntegrations = await getRegulatoryIntegrations(organization.id, profile?.country ?? null)
  const countryPack = getCountryPack(profile?.country ?? null)

  return (
    <PlatformPageShell>
    <div className="flex flex-col gap-6">
      <DetailHeader
        module="platform"
        title={organization.displayName}
        meta={
          <>
            {profile?.customerCode ?? "No commercial profile"} · {profile?.country ?? "—"} · {activeBranchCount} active branch(es) · {activeUserCount} active user(s)
          </>
        }
        badge={<StatusBadge status={organization.status} />}
        actions={<LifecycleActions organizationId={organization.id} status={organization.status} />}
      />

      {!profile ? (
        <EmptyState
          title="No commercial profile"
          description="This organization predates P5.1 (e.g. the original seed/bootstrap tenant) and has no commercial profile, plan, or subscription. It remains a fully valid, unrestricted tenant."
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">Commercial details</CardTitle>
                <CommercialProfileDialog organizationId={organization.id} profile={profile} />
              </CardHeader>
              <CardContent className="grid gap-1.5 text-sm">
                <Row label="Legal business name" value={profile.legalBusinessName} />
                <Row label="Primary contact" value={profile.primaryContactName} />
                <Row label="Primary contact email" value={profile.primaryContactEmail} />
                <Row label="Primary contact phone" value={profile.primaryContactPhone} />
                <Row label="Billing contact" value={profile.billingContactName} />
                <Row label="Billing contact email" value={profile.billingContactEmail} />
                <Row label="Implementation owner" value={profile.implementationOwner} />
                <Row label="Country Pack" value={countryPack ? `${countryPack.countryName} — ${countryPack.currency}` : "No pack defined for this country"} />
                <Row label="Internal notes" value={profile.internalNotes} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">Subscription</CardTitle>
                <SubscriptionDialog
                  organizationId={organization.id}
                  plans={plans.map((p) => ({ id: p.id, name: p.name, code: p.code }))}
                  current={
                    currentSubscription
                      ? {
                          planId: currentSubscription.planId,
                          status: currentSubscription.status,
                          startDate: currentSubscription.startDate,
                          trialEndsAt: currentSubscription.trialEndsAt,
                          agreedUserLimit: currentSubscription.agreedUserLimit,
                          agreedBranchLimit: currentSubscription.agreedBranchLimit,
                          agreedAmount: currentSubscription.agreedAmount?.toString() ?? null,
                          currency: currentSubscription.currency,
                          billingCycle: currentSubscription.billingCycle,
                          notes: currentSubscription.notes,
                        }
                      : null
                  }
                />
              </CardHeader>
              <CardContent className="grid gap-1.5 text-sm">
                {!currentSubscription ? (
                  <p className="text-muted-foreground">No subscription assigned yet.</p>
                ) : (
                  <>
                    <Row label="Plan" value={`${currentSubscription.plan.name} (${currentSubscription.plan.code})`} />
                    <Row label="Status" value={<StatusBadge status={currentSubscription.status} />} />
                    <Row label="Start date" value={formatDate(currentSubscription.startDate)} />
                    <Row label="Trial ends" value={currentSubscription.trialEndsAt ? formatDate(currentSubscription.trialEndsAt) : null} />
                    <Row label="User limit" value={(currentSubscription.agreedUserLimit ?? currentSubscription.plan.userLimit)?.toString() ?? "Unlimited"} />
                    <Row label="Branch limit" value={(currentSubscription.agreedBranchLimit ?? currentSubscription.plan.branchLimit)?.toString() ?? "Unlimited"} />
                    <Row
                      label="Agreed amount"
                      value={currentSubscription.agreedAmount ? `${currentSubscription.agreedAmount.toString()} ${currentSubscription.currency ?? ""}`.trim() : null}
                    />
                    <Row label="Billing cycle" value={currentSubscription.billingCycle} />
                    <Row label="Notes" value={currentSubscription.notes} />
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">Operations</CardTitle>
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm">
                  <Link href={`/platform/organizations/${organization.id}/implementation`}>Implementation workspace</Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/platform/organizations/${organization.id}/onboarding`}>Onboarding workspace</Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/platform/organizations/${organization.id}/uat`}>Pilot UAT</Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/platform/tickets?organizationId=${organization.id}`}>Support tickets ({openTicketCount} open)</Link>
                </Button>
              </div>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <Row label="Users" value={`${usage.activeUserCount} / ${usage.userLimit ?? "∞"}`} />
              <Row label="Branches" value={`${usage.activeBranchCount} / ${usage.branchLimit ?? "∞"}`} />
              <Row label="Modules enabled" value={`${usage.enabledModuleCount} / ${usage.totalModuleCount}`} />
              <Row label="Onboarding checklist" value={`${checklistSummary.requiredComplete} / ${checklistSummary.requiredItems} required`} />
            </CardContent>
          </Card>

          <EntitlementsCard
            organizationId={organization.id}
            entitlements={entitlements}
            planDefaultModuleKeys={(currentSubscription?.plan.defaultModuleKeys as ModuleKey[] | undefined) ?? null}
          />

          <RegulatoryCard integrations={regulatoryIntegrations} />

          <OnboardingCard
            organizationId={organization.id}
            onboardingStatus={profile.onboardingStatus}
            uatStatus={profile.uatStatus}
            uatNote={profile.uatNote}
          />

          <div id="go-live">
            <GoLiveConditionsCard organizationId={organization.id} conditions={profile.goLiveConditions} operatorEmails={operatorEmails} />
          </div>

          <GoLiveApprovalCard organizationId={organization.id} blockers={goLiveBlockers} alreadyLive={profile.commercialLifecycle === "live"} />
        </>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Branches</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Timezone</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {organization.branches.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="p-0">
                    <EmptyState title="No branches yet" className="border-none" />
                  </TableCell>
                </TableRow>
              )}
              {organization.branches.map((b) => (
                <TableRow key={b.id}>
                  <TableCell>{b.name}</TableCell>
                  <TableCell className="font-mono text-xs">{b.code}</TableCell>
                  <TableCell>{b.timezone}</TableCell>
                  <TableCell>
                    <StatusBadge status={b.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Administrators</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last login</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {admins.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="p-0">
                    <EmptyState title="No administrator account yet" className="border-none" />
                  </TableCell>
                </TableRow>
              )}
              {admins.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>
                    {a.firstName} {a.lastName}
                  </TableCell>
                  <TableCell>{a.email}</TableCell>
                  <TableCell>
                    <StatusBadge status={a.status} />
                  </TableCell>
                  <TableCell>{a.lastLoginAt ? formatDateTime(a.lastLoginAt) : "Never"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Commercial audit</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentAudit.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="p-0">
                    <EmptyState title="No platform-driven changes recorded yet" className="border-none" />
                  </TableCell>
                </TableRow>
              )}
              {recentAudit.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>{formatDateTime(a.createdAt)}</TableCell>
                  <TableCell className="font-mono text-xs">{a.action}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {a.entityType}:{a.entityId}
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

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="text-right">{value || "—"}</span>
    </div>
  )
}
