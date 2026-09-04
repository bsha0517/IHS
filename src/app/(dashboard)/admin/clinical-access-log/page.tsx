import { redirect } from "next/navigation"
import Link from "next/link"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listClinicalAccessLog, listUsersForAccessLogFilter } from "@/lib/platform/access-log"
import { listAccessibleBranches } from "@/lib/domains/billing/cashier"
import { formatDateTime } from "@/lib/utils/dates"
import { Download } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

/**
 * P2 §7: the admin/security read side for `clinical_access_log` — see
 * P2_FINDINGS.md §7 and access-log.ts's own doc comment on
 * `listClinicalAccessLog` for the full reasoning (branchId's
 * registration-branch approximation, encounterId's resourceType-"encounter"
 * scoping). Gated on `audit.review` — the same permission `/admin/audit`
 * (the mutation-audit-log viewer) already uses, whose own seed description
 * ("View audit log and clinical access log") already named this page
 * before it existed. Read-only: no action here mutates anything.
 *
 * Deliberately NOT linked from the main nav or from ordinary clinical
 * screens — reachable only by a role holding `audit.review`, matching
 * P2.md §7's "Do not expose this page to ordinary clinical staff."
 */
export default async function ClinicalAccessLogPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string
    dateFrom?: string
    dateTo?: string
    userId?: string
    patientId?: string
    encounterId?: string
    action?: string
    branchId?: string
  }>
}) {
  const session = await getCurrentSession()
  if (!session || !can(session, "audit.review")) {
    redirect("/dashboard")
  }

  const sp = await searchParams
  const page = Math.max(1, Number(sp.page ?? 1) || 1)
  const filters = {
    page,
    dateFrom: sp.dateFrom ? new Date(`${sp.dateFrom}T00:00:00`) : undefined,
    dateTo: sp.dateTo ? new Date(`${sp.dateTo}T23:59:59`) : undefined,
    userId: sp.userId || undefined,
    patientId: sp.patientId || undefined,
    encounterId: sp.encounterId || undefined,
    action: sp.action || undefined,
    branchId: sp.branchId || undefined,
  }

  const [{ entries, total, totalPages }, users, branches] = await Promise.all([
    listClinicalAccessLog(session, filters),
    listUsersForAccessLogFilter(session),
    listAccessibleBranches(session),
  ])

  const hasFilters = Boolean(sp.dateFrom || sp.dateTo || sp.userId || sp.patientId || sp.encounterId || sp.action || sp.branchId)
  const filterQuery = (overrides: Record<string, string>) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries({ ...sp, ...overrides })) {
      if (value) params.set(key, value)
    }
    return `?${params.toString()}`
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Clinical Access Log</h1>
        <p className="text-sm text-muted-foreground">
          Who accessed which patient&apos;s clinical record, when, and what they did. Restricted to the audit.review permission — not visible to ordinary clinical staff.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form method="get" className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1">
              <label htmlFor="dateFrom" className="text-xs font-medium text-muted-foreground">From</label>
              <input id="dateFrom" name="dateFrom" type="date" defaultValue={sp.dateFrom ?? ""} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs" />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="dateTo" className="text-xs font-medium text-muted-foreground">To</label>
              <input id="dateTo" name="dateTo" type="date" defaultValue={sp.dateTo ?? ""} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs" />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="userId" className="text-xs font-medium text-muted-foreground">User</label>
              <select id="userId" name="userId" defaultValue={sp.userId ?? ""} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs">
                <option value="">All users</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="action" className="text-xs font-medium text-muted-foreground">Action</label>
              <select id="action" name="action" defaultValue={sp.action ?? ""} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs">
                <option value="">All actions</option>
                <option value="view">View</option>
                <option value="print">Print</option>
                <option value="export">Export</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="branchId" className="text-xs font-medium text-muted-foreground">Branch (patient&apos;s home branch)</label>
              <select id="branchId" name="branchId" defaultValue={sp.branchId ?? ""} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs">
                <option value="">All branches</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="patientId" className="text-xs font-medium text-muted-foreground">Patient ID</label>
              <input
                id="patientId"
                name="patientId"
                type="text"
                defaultValue={sp.patientId ?? ""}
                placeholder="Paste from the patient's page URL"
                className="h-9 w-56 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="encounterId" className="text-xs font-medium text-muted-foreground">Encounter ID (if known)</label>
              <input
                id="encounterId"
                name="encounterId"
                type="text"
                defaultValue={sp.encounterId ?? ""}
                placeholder="Paste from the encounter's page URL"
                className="h-9 w-56 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs"
              />
            </div>
            <Button type="submit" variant="secondary">Apply filters</Button>
            {hasFilters && (
              <Button type="button" variant="ghost" asChild>
                <Link href="/admin/clinical-access-log">Clear</Link>
              </Button>
            )}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between">
          <div>
            <CardTitle>Access events</CardTitle>
            <CardDescription>{total} matching entr{total === 1 ? "y" : "ies"}</CardDescription>
          </div>
          {/* P4.7 §30 — export shares this page's own dateFrom/dateTo/branchId filters (never an unfiltered dump); the route independently re-checks audit.review server-side. */}
          <Button asChild size="sm" variant="outline">
            <a href={`/api/reports/export/data/clinical-access-log?${new URLSearchParams({ ...(sp.dateFrom ? { from: sp.dateFrom } : {}), ...(sp.dateTo ? { to: sp.dateTo } : {}), ...(sp.branchId ? { branchId: sp.branchId } : {}) }).toString()}`}>
              <Download className="size-4" /> Export CSV
            </a>
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Patient</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Record</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    No access events match these filters.
                  </TableCell>
                </TableRow>
              )}
              {entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="text-xs text-muted-foreground">{formatDateTime(entry.createdAt)}</TableCell>
                  <TableCell>{entry.user ? `${entry.user.firstName} ${entry.user.lastName}` : "Unknown user"}</TableCell>
                  <TableCell>
                    {entry.patient.firstName} {entry.patient.lastName}{" "}
                    <span className="text-xs text-muted-foreground">({entry.patient.mrn})</span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{entry.action}</Badge>
                  </TableCell>
                  <TableCell className="text-sm">
                    {entry.resourceType.replace(/_/g, " ")}
                    {entry.resourceId && <span className="text-muted-foreground"> #{entry.resourceId.slice(0, 8)}</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} asChild={page > 1}>
                {page > 1 ? <Link href={filterQuery({ page: String(page - 1) })}>Previous</Link> : <span>Previous</span>}
              </Button>
              <span className="text-sm text-muted-foreground">Page {page} of {totalPages}</span>
              <Button variant="outline" size="sm" disabled={page >= totalPages} asChild={page < totalPages}>
                {page < totalPages ? <Link href={filterQuery({ page: String(page + 1) })}>Next</Link> : <span>Next</span>}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
