import Link from "next/link"
import { redirect } from "next/navigation"
import { Plus, Search } from "lucide-react"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listPatients } from "@/lib/domains/patients/service"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { calculateAge } from "@/lib/utils/dates"

export default async function PatientsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>
}) {
  const session = await getCurrentSession()
  if (!session || !can(session, "patient.view")) redirect("/dashboard")

  const { q, page: pageParam } = await searchParams
  const page = Math.max(1, Number(pageParam ?? 1) || 1)
  const { patients, total, totalPages } = await listPatients(session, { search: q, page })

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Patients</h1>
          <p className="text-sm text-muted-foreground">{total} registered patient(s)</p>
        </div>
        {can(session, "patient.create") && (
          <Button asChild size="sm">
            <Link href="/patients/new">
              <Plus /> Register Patient
            </Link>
          </Button>
        )}
      </div>

      <form className="flex max-w-md items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input name="q" defaultValue={q} placeholder="Search by name, MRN, or phone" className="pl-8" />
        </div>
        <Button type="submit" variant="outline" size="sm">
          Search
        </Button>
      </form>

      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>MRN</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Age / Gender</TableHead>
                <TableHead>Mobile</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {patients.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    No patients found.
                  </TableCell>
                </TableRow>
              )}
              {patients.map((patient) => (
                <TableRow key={patient.id} className="cursor-pointer">
                  <TableCell>
                    <Link href={`/patients/${patient.id}`} className="font-medium hover:underline">
                      {patient.mrn}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/patients/${patient.id}`} className="hover:underline">
                      {patient.firstName} {patient.middleName ? `${patient.middleName} ` : ""}
                      {patient.lastName}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {calculateAge(patient.dob)}y · {patient.gender}
                  </TableCell>
                  <TableCell>{patient.mobile}</TableCell>
                  <TableCell>
                    <Badge variant={patient.status === "active" ? "default" : "secondary"}>{patient.status}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} asChild={page > 1}>
                {page > 1 ? <Link href={`/patients?page=${page - 1}${q ? `&q=${q}` : ""}`}>Previous</Link> : <span>Previous</span>}
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {page} of {totalPages}
              </span>
              <Button variant="outline" size="sm" disabled={page >= totalPages} asChild={page < totalPages}>
                {page < totalPages ? (
                  <Link href={`/patients?page=${page + 1}${q ? `&q=${q}` : ""}`}>Next</Link>
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
