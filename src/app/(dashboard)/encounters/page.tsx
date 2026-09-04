import Link from "next/link"
import { redirect } from "next/navigation"
import { Search } from "lucide-react"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listEncounters } from "@/lib/domains/clinical/encounters"
import { Card, CardContent } from "@/components/ui/card"
import { PageHeader } from "@/components/ui/page-header"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { formatDateTime } from "@/lib/utils/dates"
import type { $Enums } from "@/generated/prisma/client"

const STATUSES: $Enums.EncounterStatus[] = ["draft", "active", "completed", "finalized", "cancelled", "entered_in_error"]

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  draft: "outline",
  active: "secondary",
  completed: "default",
  finalized: "default",
  cancelled: "destructive",
  entered_in_error: "destructive",
}

function queryString(params: Record<string, string | undefined>) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value)
  }
  const str = search.toString()
  return str ? `?${str}` : ""
}

export default async function EncountersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>
}) {
  const session = await getCurrentSession()
  if (!session || !can(session, "encounter.view")) redirect("/dashboard")

  const { q, status, page: pageParam } = await searchParams
  const page = Math.max(1, Number(pageParam ?? 1) || 1)
  const statusFilter = status && STATUSES.includes(status as $Enums.EncounterStatus) ? (status as $Enums.EncounterStatus) : undefined

  const { encounters, total, totalPages } = await listEncounters(session, { search: q, status: statusFilter, page })

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Encounters" description={`${total} encounter(s)`} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <form className="flex max-w-md items-center gap-2">
          {status && <input type="hidden" name="status" value={status} />}
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input name="q" defaultValue={q} placeholder="Search by encounter #, or patient" className="pl-8" />
          </div>
          <Button type="submit" variant="outline" size="sm">
            Search
          </Button>
        </form>

        <div className="flex flex-wrap gap-1">
          <Button variant={!status ? "secondary" : "ghost"} size="sm" asChild>
            <Link href={`/encounters${queryString({ q })}`}>All</Link>
          </Button>
          {STATUSES.map((s) => (
            <Button key={s} variant={status === s ? "secondary" : "ghost"} size="sm" asChild>
              <Link href={`/encounters${queryString({ q, status: s })}`} className="capitalize">
                {s.replace(/_/g, " ")}
              </Link>
            </Button>
          ))}
        </div>
      </div>

      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Encounter #</TableHead>
                <TableHead>Patient</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Episode</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {encounters.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    No encounters found.
                  </TableCell>
                </TableRow>
              )}
              {encounters.map((encounter) => (
                <TableRow key={encounter.id}>
                  <TableCell>
                    <Link href={`/encounters/${encounter.id}`} className="font-medium hover:underline">
                      {encounter.encounterNumber}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/patients/${encounter.patientId}`} className="hover:underline">
                      {encounter.patient.firstName} {encounter.patient.lastName}
                    </Link>
                  </TableCell>
                  <TableCell className="capitalize">{encounter.encounterType.replace(/_/g, " ")}</TableCell>
                  <TableCell>
                    {encounter.provider.firstName} {encounter.provider.lastName}
                  </TableCell>
                  <TableCell>{encounter.episode?.title ?? "—"}</TableCell>
                  <TableCell>{formatDateTime(encounter.startAt)}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[encounter.status] ?? "outline"} className="capitalize">
                      {encounter.status.replace(/_/g, " ")}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} asChild={page > 1}>
                {page > 1 ? <Link href={`/encounters${queryString({ q, status, page: String(page - 1) })}`}>Previous</Link> : <span>Previous</span>}
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {page} of {totalPages}
              </span>
              <Button variant="outline" size="sm" disabled={page >= totalPages} asChild={page < totalPages}>
                {page < totalPages ? (
                  <Link href={`/encounters${queryString({ q, status, page: String(page + 1) })}`}>Next</Link>
                ) : (
                  <span>Next</span>
                )}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
