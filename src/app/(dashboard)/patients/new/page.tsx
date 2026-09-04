import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listAccessibleBranches } from "@/lib/domains/billing/cashier"
import { listProviders } from "@/lib/domains/providers/service"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { RegistrationForm } from "@/app/(dashboard)/patients/new/registration-form"

export default async function NewPatientPage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "patient.create")) redirect("/dashboard")

  // P3.13: this page unconditionally called listBranches, which requires
  // branch.view — a permission the seeded Receptionist role (whose actual
  // job this page IS) does not hold, per prisma/seed.ts. Reproduced live
  // during P3.13's own browser walkthrough: registering a new patient as
  // Receptionist crashed outright. P3.1 already fixed this identical class
  // of bug for reception/page.tsx and appointments/page.tsx via
  // listAccessibleBranches (needs no permission beyond branchIds on the
  // session) — this page was missed at the time.
  const [branches, allProviders] = await Promise.all([listAccessibleBranches(session), listProviders(session)])

  // Prisma's Decimal fields (consultationFee) can't cross the Server->Client boundary.
  const providers = allProviders.map((p) => ({ id: p.id, firstName: p.firstName, lastName: p.lastName }))

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Register Patient</h1>
        <p className="text-sm text-muted-foreground">
          We check for likely duplicates on phone, email, national ID, and name + date of birth before saving —
          this only warns, it never blocks registration (spec.md §9).
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Patient details</CardTitle>
          <CardDescription>Fields marked * are required.</CardDescription>
        </CardHeader>
        <CardContent>
          <RegistrationForm branches={branches} providers={providers} defaultBranchId={session.activeBranchId} />
        </CardContent>
      </Card>
    </div>
  )
}
