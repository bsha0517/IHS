import Link from "next/link"
import { listOrganizationsForPlatform } from "@/lib/domains/commercial/organizations"
import { PageHeader } from "@/components/ui/page-header"
import { FilterBar, FilterField } from "@/components/ui/filter-bar"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { StatusBadge } from "@/components/ui/status-badge"
import { EmptyState } from "@/components/ui/empty-state"
import { PaginationControls } from "@/components/domain/pagination-controls"
import { formatDate } from "@/lib/utils/dates"
import { PlatformPageShell } from "@/components/layout/platform-page-shell"

/**
 * P5.1 §20/§22/§46/§86: operational metadata only — organization name,
 * country, plan, subscription/onboarding status, active branch/user counts,
 * OrgStatus. No patient name, no diagnosis, no clinical content of any kind
 * — nothing on this page could even display PHI, since nothing here queries
 * a Patient/clinical table at all.
 */
export default async function PlatformOrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>
}) {
  const sp = await searchParams
  const { organizations, total, page, totalPages } = await listOrganizationsForPlatform({
    search: sp.q,
    page: sp.page ? Number(sp.page) : undefined,
  })

  return (
    <PlatformPageShell>
    <div className="flex flex-col gap-6">
      <PageHeader title="Organizations" module="platform" description={`${total} organization(s)`} />

      <FilterBar method="get">
        <FilterField label="Search" htmlFor="q" className="min-w-[240px]">
          <Input id="q" name="q" defaultValue={sp.q ?? ""} placeholder="Name, customer code, contact..." />
        </FilterField>
        <Button type="submit" size="sm">
          Filter
        </Button>
        {sp.q && (
          <Button asChild type="button" variant="ghost" size="sm">
            <Link href="/platform/organizations">Reset</Link>
          </Button>
        )}
      </FilterBar>

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
                <TableHead className="text-right">Branches</TableHead>
                <TableHead className="text-right">Users</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {organizations.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="p-0">
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
