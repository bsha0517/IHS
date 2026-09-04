import Link from "next/link"
import type { ReactNode } from "react"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { getMyOpenSession, getCashierSession, listAccessibleBranches } from "@/lib/domains/billing/cashier"
import { listPendingCharges } from "@/lib/domains/billing/charges"
import { listPatientInvoices, listOutstandingInvoices } from "@/lib/domains/billing/invoices"
import { listPatientPayments } from "@/lib/domains/billing/payments"
import { getPatient } from "@/lib/domains/patients/service"
import { listServices } from "@/lib/domains/services/service"
import { listSellableProducts } from "@/lib/domains/inventory/products"
import { listProviders } from "@/lib/domains/providers/service"
import { listPatientCoverage } from "@/lib/domains/claims/coverage"
import { formatDateTime } from "@/lib/utils/dates"
import { Card, CardContent } from "@/components/ui/card"
import { StatusBadge } from "@/components/ui/status-badge"
import { WorkspaceHeader } from "@/components/ui/page-header"
import { EmptyState } from "@/components/ui/empty-state"
import { OpenRegisterForm } from "@/app/(dashboard)/pos/open-register-form"
import { CashierBar } from "@/app/(dashboard)/pos/cashier-bar"
import { PosPatientSearch } from "@/app/(dashboard)/pos/pos-patient-search"
import { PendingCharges } from "@/app/(dashboard)/pos/pending-charges"

// P4.7A.1 §23 — POS has three distinct render branches (no register open /
// register open + searching / patient selected + billing), each of which
// previously built its own ad hoc `<h1>`. One shared workspace shell now
// backs all three so the page never looks like three different screens
// stitched together — only the description and secondary action change.
function PosShell({ meta, action, children }: { meta?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <WorkspaceHeader title="Point of Sale" meta={meta} actions={action} />
      {children}
    </div>
  )
}

export default async function PosPage({ searchParams }: { searchParams: Promise<{ patientId?: string }> }) {
  const session = await getCurrentSession()
  if (!session || !can(session, "invoice.create")) redirect("/dashboard")

  const { patientId } = await searchParams
  const openSession = await getMyOpenSession(session)

  if (!openSession) {
    const branches = await listAccessibleBranches(session)
    return (
      <PosShell meta="Open a cashier register to start taking payments.">
        <OpenRegisterForm branches={branches} />
      </PosShell>
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
    // P3.7 §32: day-to-day cashier visibility before the register closes —
    // previously the register-open landing page showed nothing but the
    // patient search until you closed it (the only place today's payments
    // were ever visible was the post-close summary). Reuses
    // `getCashierSession`'s own payments list (already scoped to this
    // session) and the existing, already-paginated `listOutstandingInvoices`
    // — no new query shape, no executive reporting (that's P3.9).
    const [todaySession, outstanding] = await Promise.all([
      getCashierSession(session, openSession.id),
      listOutstandingInvoices(session, { branchId: openSession.branchId }),
    ])
    return (
      <PosShell meta="Search for a patient to view pending charges and take payment.">
        <CashierBar cashierSession={cashierSessionView} />
        <PosPatientSearch />

        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardContent className="pt-6">
              <p className="mb-3 text-sm font-medium">This register&apos;s payments today ({todaySession.payments.length})</p>
              {todaySession.payments.length === 0 && <EmptyState title="No payments yet" description="No payments have been recorded on this register today." className="border-none py-6" />}
              <div className="grid gap-2">
                {todaySession.payments.slice(0, 8).map((p) => (
                  <div key={p.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                    <span>
                      {p.receiptNumber} · <span className="capitalize">{p.method}</span>
                    </span>
                    <span className="text-right font-medium tabular-nums">{Number(p.amount).toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="mb-3 text-sm font-medium">
                Outstanding invoices at this branch ({outstanding.total}) —{" "}
                <span className="text-destructive">{outstanding.totalOutstanding.toFixed(2)}</span>
              </p>
              {outstanding.invoices.length === 0 && <EmptyState title="No outstanding invoices" className="border-none py-6" />}
              <div className="grid gap-2">
                {outstanding.invoices.slice(0, 8).map((inv) => (
                  <Link
                    key={inv.id}
                    href={`/invoices/${inv.id}`}
                    className="flex items-center justify-between rounded-md border border-border p-2 text-sm hover:bg-muted"
                  >
                    <span>
                      {inv.invoiceNumber} · {inv.patient.firstName} {inv.patient.lastName}
                    </span>
                    <span className="text-right font-medium tabular-nums text-destructive">
                      {(Number(inv.totalAmount) - Number(inv.paidAmount)).toFixed(2)}
                    </span>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </PosShell>
    )
  }

  const [patient, charges, invoices, payments, services, products, providers, coverages] = await Promise.all([
    getPatient(session, patientId),
    listPendingCharges(session, patientId),
    listPatientInvoices(session, patientId),
    can(session, "payment.view") ? listPatientPayments(session, patientId) : Promise.resolve([]),
    listServices(session),
    listSellableProducts(session),
    // P3.7 §42: was unconditional — `listProviders` requires `provider.view`,
    // which neither Cashier nor Receptionist holds (confirmed via direct
    // seed.ts cross-reference), so this crashed the entire POS page with a
    // pending patient the instant either role tried to bill anyone. The
    // provider field itself is optional ("for commission attribution") —
    // the same defensive-loading class of fix P3.2/P3.5/P3.6 already
    // established for this exact "widen elsewhere, forget an unconditional
    // fetch" pitfall.
    can(session, "provider.view") ? listProviders(session) : Promise.resolve([]),
    can(session, "coverage.manage") ? listPatientCoverage(session, patientId) : Promise.resolve([]),
  ])

  // P3.7 §9: "what is outstanding" across every open invoice — a real,
  // summed figure a cashier can act on immediately, not something they'd
  // have to add up themselves from the invoice list below.
  const outstandingBalance = invoices
    .filter((inv) => inv.status === "issued" || inv.status === "partially_paid")
    .reduce((sum, inv) => sum + (Number(inv.totalAmount) - Number(inv.paidAmount)), 0)

  const chargeRows = charges.map((c) => ({
    id: c.id,
    description: c.description,
    sourceType: c.sourceType,
    quantity: c.quantity,
    unitPrice: Number(c.unitPrice),
    amount: Number(c.amount),
  }))
  const serviceOptions = services.map((s) => ({ id: s.id, name: s.name, price: Number(s.price) }))
  const productOptions = products.map((p) => ({ id: p.id, name: p.name, price: p.price, unit: p.unit }))
  const providerOptions = providers.map((p) => ({ id: p.id, firstName: p.firstName, lastName: p.lastName }))
  const coverageOptions = coverages
    .filter((c) => c.status === "active")
    .map((c) => ({ id: c.id, label: `${c.policy.insurancePlan.payor.name} — ${c.policy.insurancePlan.name} (${c.memberId})` }))

  return (
    <PosShell
      action={
        <Link href="/pos" className="text-sm text-muted-foreground hover:underline">
          Change patient
        </Link>
      }
    >
      <CashierBar cashierSession={cashierSessionView} />

      {/* P4.7A.1 §24/§25 — the cashier's own context bar: who's being billed,
          and the one figure that matters most (outstanding balance) given
          the strongest visual weight on the page, right-aligned like every
          other money figure below it. */}
      <Card className="border-l-4 border-l-primary">
        <CardContent className="flex flex-wrap items-center justify-between gap-4 pt-6">
          <div>
            <p className="font-medium">
              {patient.firstName} {patient.lastName}
            </p>
            <p className="text-sm text-muted-foreground">
              {patient.mrn} · {patient.mobile}
            </p>
          </div>
          {/* P3.7 §9: the one figure a cashier most needs at a glance —
              "what is this patient outstanding right now" — without having
              to open Patient 360 or add up the invoice list below. */}
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Outstanding balance</p>
            <p className={`text-2xl font-semibold tabular-nums tracking-tight ${outstandingBalance > 0 ? "text-destructive" : "text-success"}`}>
              {outstandingBalance.toFixed(2)}
            </p>
          </div>
          <Link href={`/patients/${patientId}`} className="text-sm text-muted-foreground hover:underline">
            Full patient record →
          </Link>
        </CardContent>
      </Card>

      <PendingCharges
        patientId={patientId}
        branchId={openSession.branchId}
        charges={chargeRows}
        services={serviceOptions}
        products={productOptions}
        providers={providerOptions}
        coverages={coverageOptions}
        canVoid={can(session, "charge.void")}
        canDiscount={can(session, "invoice.discount")}
      />

      <Card>
        <CardContent className="pt-6">
          <p className="mb-3 text-sm font-medium">Recent invoices</p>
          {invoices.length === 0 && <EmptyState title="No invoices yet" className="border-none py-6" />}
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
                  <span className="text-right font-medium tabular-nums">{Number(inv.totalAmount).toFixed(2)}</span>
                  <StatusBadge status={inv.status} />
                </span>
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>

      {can(session, "payment.view") && (
        <Card>
          <CardContent className="pt-6">
            <p className="mb-3 text-sm font-medium">Recent payments</p>
            {payments.length === 0 && <EmptyState title="No payments recorded" className="border-none py-6" />}
            <div className="grid gap-2">
              {payments.slice(0, 5).map((p) => (
                <div key={p.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                  <span>
                    {p.receiptNumber} · {formatDateTime(p.receivedAt)} · <span className="capitalize">{p.method}</span>
                  </span>
                  <span className="text-right font-medium tabular-nums">{Number(p.amount).toFixed(2)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </PosShell>
  )
}
