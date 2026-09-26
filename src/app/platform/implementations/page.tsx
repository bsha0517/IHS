import Link from "next/link"
import { listImplementationPortfolio, listImplementationOwners } from "@/lib/domains/commercial/implementation"
import { listOrganizationCountries } from "@/lib/domains/commercial/organizations"
import { PageHeader } from "@/components/ui/page-header"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/empty-state"
import { formatDate } from "@/lib/utils/dates"
import { PlatformPageShell } from "@/components/layout/platform-page-shell"
import type { $Enums } from "@/generated/prisma/client"

const LIFECYCLES: $Enums.CommercialLifecycle[] = ["onboarding", "live", "closed"]

/**
 * P5.8 §34: a Platform Operator's view across every customer implementation
 * at once. Deliberately not an analytics dashboard — no readiness score, no
 * charts, just the same explicit signals the per-organization workspace
 * shows, one row per organization.
 */
export default async function ImplementationsPortfolioPage({
  searchParams,
}: {
  searchParams: Promise<{ country?: string; owner?: string; lifecycle?: string; blocked?: string }>
}) {
  const sp = await searchParams
  const lifecycle = sp.lifecycle && (LIFECYCLES as string[]).includes(sp.lifecycle) ? (sp.lifecycle as $Enums.CommercialLifecycle) : undefined

  const [rows, countries, owners] = await Promise.all([
    listImplementationPortfolio({ country: sp.country, implementationOwner: sp.owner, commercialLifecycle: lifecycle }),
    listOrganizationCountries(),
    listImplementationOwners(),
  ])

  const filteredRows = sp.blocked === "1" ? rows.filter((r) => r.blockingCount > 0) : rows

  function filterHref(overrides: Partial<{ country: string; owner: string; lifecycle: string; blocked: string }>) {
    const params = new URLSearchParams({
      ...(sp.country ? { country: sp.country } : {}),
      ...(sp.owner ? { owner: sp.owner } : {}),
      ...(sp.lifecycle ? { lifecycle: sp.lifecycle } : {}),
      ...(sp.blocked ? { blocked: sp.blocked } : {}),
      ...overrides,
    })
    for (const [key, value] of Object.entries(overrides)) if (!value) params.delete(key)
    const qs = params.toString()
    return qs ? `/platform/implementations?${qs}` : "/platform/implementations"
  }

  return (
    <PlatformPageShell>
      <div className="flex flex-col gap-6">
        <PageHeader title="Implementations" module="platform" description={`${filteredRows.length} customer implementation(s)`} />

        <div className="flex flex-wrap items-center gap-3 text-sm">
          <FilterGroup label="Lifecycle">
            <Link href={filterHref({ lifecycle: "" })} className={!sp.lifecycle ? "font-semibold underline" : "text-muted-foreground"}>
              All
            </Link>
            {LIFECYCLES.map((l) => (
              <Link key={l} href={filterHref({ lifecycle: l })} className={sp.lifecycle === l ? "font-semibold underline" : "text-muted-foreground"}>
                {l}
              </Link>
            ))}
          </FilterGroup>
          <FilterGroup label="Country">
            <Link href={filterHref({ country: "" })} className={!sp.country ? "font-semibold underline" : "text-muted-foreground"}>
              All
            </Link>
            {countries.map((c) => (
              <Link key={c} href={filterHref({ country: c })} className={sp.country === c ? "font-semibold underline" : "text-muted-foreground"}>
                {c}
              </Link>
            ))}
          </FilterGroup>
          {owners.length > 0 && (
            <FilterGroup label="Owner">
              <Link href={filterHref({ owner: "" })} className={!sp.owner ? "font-semibold underline" : "text-muted-foreground"}>
                All
              </Link>
              {owners.map((o) => (
                <Link key={o} href={filterHref({ owner: o })} className={sp.owner === o ? "font-semibold underline" : "text-muted-foreground"}>
                  {o}
                </Link>
              ))}
            </FilterGroup>
          )}
          <FilterGroup label="Status">
            <Link href={filterHref({ blocked: "" })} className={sp.blocked !== "1" ? "font-semibold underline" : "text-muted-foreground"}>
              All
            </Link>
            <Link href={filterHref({ blocked: "1" })} className={sp.blocked === "1" ? "font-semibold underline" : "text-muted-foreground"}>
              Blocked only
            </Link>
          </FilterGroup>
        </div>

        <Card>
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead>Country</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Lifecycle</TableHead>
                  <TableHead>Target go-live</TableHead>
                  <TableHead>Blockers</TableHead>
                  <TableHead>Handover</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="p-0">
                      <EmptyState title="No matching implementations" className="border-none" />
                    </TableCell>
                  </TableRow>
                )}
                {filteredRows.map((r) => (
                  <TableRow key={r.organizationId}>
                    <TableCell>
                      <Link href={`/platform/organizations/${r.organizationId}/implementation`} className="hover:underline">
                        <div className="font-medium">{r.displayName}</div>
                        <div className="font-mono text-xs text-muted-foreground">{r.customerCode}</div>
                      </Link>
                    </TableCell>
                    <TableCell>{r.country}</TableCell>
                    <TableCell>{r.planName ?? "—"}</TableCell>
                    <TableCell>{r.implementationOwner ?? "—"}</TableCell>
                    <TableCell className="capitalize">{r.commercialLifecycle}</TableCell>
                    <TableCell>{r.targetGoLiveDate ? formatDate(r.targetGoLiveDate) : "—"}</TableCell>
                    <TableCell>
                      {r.blockingCount > 0 ? <Badge variant="destructive">{r.blockingCount} blocking</Badge> : <Badge variant="success">None</Badge>}
                    </TableCell>
                    <TableCell>{r.handoverCompletedAt ? <Badge variant="success">Complete</Badge> : "—"}</TableCell>
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

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">{label}:</span>
      {children}
    </div>
  )
}
