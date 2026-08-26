import Link from "next/link"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { getMyOpenSession, listAccessibleBranches } from "@/lib/domains/billing/cashier"
import { listPendingCharges } from "@/lib/domains/billing/charges"
import { listPatientInvoices } from "@/lib/domains/billing/invoices"
import { getPatient } from "@/lib/domains/patients/service"
import { listServices } from "@/lib/domains/services/service"
import { listProviders } from "@/lib/domains/providers/service"
import { listPatientCoverage } from "@/lib/domains/claims/coverage"
import { formatDateTime } from "@/lib/utils/dates"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { OpenRegisterForm } from "@/app/(dashboard)/pos/open-register-form"
import { CashierBar } from "@/app/(dashboard)/pos/cashier-bar"
import { PosPatientSearch } from "@/app/(dashboard)/pos/pos-patient-search"
import { PendingCharges } from "@/app/(dashboard)/pos/pending-charges"

export default async function PosPage({ searchParams }: { searchParams: Promise<{ patientId?: string }> }) {
  const session = await getCurrentSession()
  if (!session || !can(session, "invoice.create")) redirect("/dashboard")

  const { patientId } = await searchParams
  const openSession = await getMyOpenSession(session)

  if (!openSession) {
    const branches = await listAccessibleBranches(session)
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold tracking-tight">Point of Sale</h1>
        <p className="text-center text-sm text-muted-foreground">Open a cashier register to start taking payments.</p>
        <OpenRegisterForm branches={branches} />
      </div>
    )
  }

  const branchName = (await listAccessibleBranches(session)).find((b) => b.id === openSession.branchId)?.name ?? "Branch"
  const cashierSessionView = {
    id: openSession.id,
    branchName,
    openingCash: Number(openSession.openingCash),
    openedAt: openSession.openedAt,
  }

  if (!patientId) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold tracking-tight">Point of Sale</h1>
        <CashierBar cashierSession={cashierSessionView} />
        <p className="text-center text-sm text-muted-foreground">Search for a patient to view pending charges and take payment.</p>
        <PosPatientSearch />
      </div>
    )
  }

  const [patient, charges, invoices, services, providers, coverages] = await Promise.all([
    getPatient(session, patientId),
    listPendingCharges(session, patientId),
    listPatientInvoices(session, patientId),
    listServices(session),
    listProviders(session),
    can(session, "coverage.manage") ? listPatientCoverage(session, patientId) : Promise.resolve([]),
  ])

  const chargeRows = charges.map((c) => ({
    id: c.id,
    description: c.description,
    sourceType: c.sourceType,
    quantity: c.quantity,
    unitPrice: Number(c.unitPrice),
    amount: Number(c.amount),
  }))
  const serviceOptions = services.map((s) => ({ id: s.id, name: s.name, price: Number(s.price) }))
  const providerOptions = providers.map((p) => ({ id: p.id, firstName: p.firstName, lastName: p.lastName }))
  const coverageOptions = coverages
    .filter((c) => c.status === "active")
    .map((c) => ({ id: c.id, label: `${c.policy.insurancePlan.payor.name} — ${c.policy.insurancePlan.name} (${c.memberId})` }))

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Point of Sale</h1>
        <Link href="/pos" className="text-sm text-muted-foreground hover:underline">
          Change patient
        </Link>
      </div>
      <CashierBar cashierSession={cashierSessionView} />

      <Card>
        <CardContent className="pt-6">
          <p className="font-medium">
            {patient.firstName} {patient.lastName}
          </p>
          <p className="text-sm text-muted-foreground">
            {patient.mrn} · {patient.mobile}
          </p>
        </CardContent>
      </Card>

      <PendingCharges
        patientId={patientId}
        branchId={openSession.branchId}
        charges={chargeRows}
        services={serviceOptions}
        providers={providerOptions}
        coverages={coverageOptions}
        canVoid={can(session, "charge.void")}
      />

      <Card>
        <CardContent className="pt-6">
          <p className="mb-3 text-sm font-medium">Recent invoices</p>
          {invoices.length === 0 && <p className="text-sm text-muted-foreground">No invoices yet.</p>}
          <div className="grid gap-2">
            {invoices.slice(0, 5).map((inv) => (
              <Link
                key={inv.id}
                href={`/invoices/${inv.id}`}
                className="flex items-center justify-between rounded-md border border-border p-2 text-sm hover:bg-muted"
              >
                <span>
                  {inv.invoiceNumber} · {formatDateTime(inv.createdAt)}
                </span>
                <span className="flex items-center gap-2">
                  {Number(inv.totalAmount).toFixed(2)}
                  <Badge variant={inv.status === "paid" ? "default" : "outline"}>{inv.status.replace("_", " ")}</Badge>
                </span>
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
