import Link from "next/link"
import { redirect } from "next/navigation"
import { Search } from "lucide-react"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listEpisodes } from "@/lib/domains/clinical/episodes"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { formatDate } from "@/lib/utils/dates"
import type { $Enums } from "@/generated/prisma/client"

const STATUSES: $Enums.EpisodeStatus[] = ["open", "active", "completed", "cancelled"]

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  open: "outline",
  active: "secondary",
  completed: "default",
  cancelled: "destructive",
}

function queryString(params: Record<string, string | undefined>) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value)
  }
  const str = search.toString()
  return str ? `?${str}` : ""
}

export default async function EpisodesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>
}) {
  const session = await getCurrentSession()
  if (!session || !can(session, "encounter.view")) redirect("/dashboard")

  const { q, status, page: pageParam } = await searchParams
  const page = Math.max(1, Number(pageParam ?? 1) || 1)
  const statusFilter = status && STATUSES.includes(status as $Enums.EpisodeStatus) ? (status as $Enums.EpisodeStatus) : undefined

  const { episodes, total, totalPages } = await listEpisodes(session, { search: q, status: statusFilter, page })

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Episodes</h1>
        <p className="text-sm text-muted-foreground">{total} episode(s) of care</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <form className="flex max-w-md items-center gap-2">
          {status && <input type="hidden" name="status" value={status} />}
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input name="q" defaultValue={q} placeholder="Search by title, episode #, or patient" className="pl-8" />
          </div>
          <Button type="submit" variant="outline" size="sm">
            Search
          </Button>
        </form>

        <div className="flex flex-wrap gap-1">
          <Button variant={!status ? "secondary" : "ghost"} size="sm" asChild>
            <Link href={`/episodes${queryString({ q })}`}>All</Link>
          </Button>
          {STATUSES.map((s) => (
            <Button key={s} variant={status === s ? "secondary" : "ghost"} size="sm" asChild>
              <Link href={`/episodes${queryString({ q, status: s })}`} className="capitalize">
                {s}
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
                <TableHead>Episode #</TableHead>
                <TableHead>Patient</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Primary Provider</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {episodes.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    No episodes found.
                  </TableCell>
                </TableRow>
              )}
              {episodes.map((episode) => (
                <TableRow key={episode.id}>
                  <TableCell>
                    <Link href={`/patients/${episode.patientId}`} className="font-medium hover:underline">
                      {episode.episodeNumber}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/patients/${episode.patientId}`} className="hover:underline">
                      {episode.patient.firstName} {episode.patient.lastName}
                    </Link>
                  </TableCell>
                  <TableCell>{episode.title}</TableCell>
                  <TableCell>{episode.episodeType}</TableCell>
                  <TableCell>
                    {episode.primaryProvider ? `${episode.primaryProvider.firstName} ${episode.primaryProvider.lastName}` : "—"}
                  </TableCell>
                  <TableCell>{formatDate(episode.startDate)}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[episode.status] ?? "outline"} className="capitalize">
                      {episode.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} asChild={page > 1}>
                {page > 1 ? <Link href={`/episodes${queryString({ q, status, page: String(page - 1) })}`}>Previous</Link> : <span>Previous</span>}
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {page} of {totalPages}
              </span>
              <Button variant="outline" size="sm" disabled={page >= totalPages} asChild={page < totalPages}>
                {page < totalPages ? (
                  <Link href={`/episodes${queryString({ q, status, page: String(page + 1) })}`}>Next</Link>
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
