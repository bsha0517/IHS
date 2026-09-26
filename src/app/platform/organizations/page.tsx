import Link from "next/link"
import { listOrganizationsForPlatform, listOrganizationCountries } from "@/lib/domains/commercial/organizations"
import { PageHeader } from "@/components/ui/page-header"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { StatusBadge } from "@/components/ui/status-badge"
import { EmptyState } from "@/components/ui/empty-state"
import { PaginationControls } from "@/components/domain/pagination-controls"
import { formatDate } from "@/lib/utils/dates"
import { PlatformPageShell } from "@/components/layout/platform-page-shell"
import { OrganizationFilters } from "@/app/platform/organizations/organization-filters"
import type { $Enums } from "@/generated/prisma/client"

/**
 * P5.1 §20/§22/§46/§86: operational metadata only — organization name,
 * country, plan, subscription/onboarding status, active branch/user counts,
 * OrgStatus. No patient name, no diagnosis, no clinical content of any kind
 * — nothing on this page could even display PHI, since nothing here queries
 * a Patient/clinical table at all.
 *
 * P5.6 Part 2: adds country/subscription/onboarding/go-live filters and a
 * Go-live column (commercialLifecycle, already fetched by
 * listOrganizationsForPlatform — no extra per-row query) on top of the
 * existing search-only list.
 */
export default async function PlatformOrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string
    page?: string
    country?: string
    subscriptionStatus?: string
    onboardingStatus?: string
    goLive?: string
  }>
}) {
  const sp = await searchParams
  const [{ organizations, total, page, totalPages }, countries] = await Promise.all([
    listOrganizationsForPlatform({
      search: sp.q,
      page: sp.page ? Number(sp.page) : undefined,
      country: sp.country,
      subscriptionStatus: sp.subscriptionStatus as $Enums.SubscriptionStatus | undefined,
      onboardingStatus: sp.onboardingStatus as $Enums.CommercialOnboardingStatus | undefined,
      commercialLifecycle: sp.goLive as $Enums.CommercialLifecycle | undefined,
    }),
    listOrganizationCountries(),
  ])

  return (
    <PlatformPageShell>
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Organizations"
        module="platform"
        description={`${total} organization(s)`}
        primaryAction={
          <Button asChild size="sm">
            <Link href="/platform/provision">+ Provision Clinic</Link>
          </Button>
        }
      />

      <OrganizationFilters countries={countries} sp={sp} />

      <Card>
        <CardContent className="pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Country</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Subscription</TableHead>
                <TableHead>Onboarding</TableHead>
                <TableHead>Go-live</TableHead>
                <TableHead className="text-right">Branches</TableHead>
                <TableHead className="text-right">Users</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {organizations.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="p-0">
                    <EmptyState title="No organizations found" description="Provision the first clinic to see it here." className="border-none" />
                  </TableCell>
                </TableRow>
              )}
              {organizations.map((o) => (
                <TableRow key={o.id}>
                  <TableCell>
                    <Link href={`/platform/organizations/${o.id}`} className="hover:underline">
                      <div className="font-medium">{o.displayName}</div>
                      {o.customerCode && <div className="text-xs text-muted-foreground">{o.customerCode}</div>}
                    </Link>
                  </TableCell>
                  <TableCell>{o.country ?? "—"}</TableCell>
                  <TableCell>{o.currentSubscription?.plan.name ?? "—"}</TableCell>
                  <TableCell>{o.currentSubscription ? <StatusBadge status={o.currentSubscription.status} /> : "—"}</TableCell>
                  <TableCell>{o.onboardingStatus ? <StatusBadge status={o.onboardingStatus} /> : "—"}</TableCell>
                  <TableCell>{o.commercialLifecycle ? <StatusBadge status={o.commercialLifecycle} /> : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{o.activeBranchCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{o.activeUserCount}</TableCell>
                  <TableCell>
                    <StatusBadge status={o.status} />
                  </TableCell>
                  <TableCell>{formatDate(o.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <PaginationControls page={page} totalPages={totalPages} total={total} basePath="/platform/organizations" searchParams={sp} />
    </div>
    </PlatformPageShell>
  )
}
