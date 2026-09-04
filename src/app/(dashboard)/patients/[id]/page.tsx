import Link from "next/link"
import { redirect } from "next/navigation"
import { AlertTriangle, Phone, Mail, MapPin } from "lucide-react"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { getPatient } from "@/lib/domains/patients/service"
import { loadOrNotFound } from "@/lib/platform/not-found"
import { listPatientAppointments } from "@/lib/domains/appointments/service"
import { listPatientLabResults } from "@/lib/domains/laboratory/results"
import { listPatientImagingResults } from "@/lib/domains/radiology/results"
import { getPatientStatement } from "@/lib/domains/billing/statement"
import { listAccessibleBranches } from "@/lib/domains/billing/cashier"
import { listProviders } from "@/lib/domains/providers/service"
import { listServices } from "@/lib/domains/services/service"
import { Badge } from "@/components/ui/badge"
import { StatusBadge } from "@/components/ui/status-badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { EmptyState } from "@/components/ui/empty-state"
import { ComingSoon } from "@/components/layout/coming-soon"
import { calculateAge, formatDate, formatDateTime } from "@/lib/utils/dates"
import { APPOINTMENT_STATUS_LABEL } from "@/lib/utils/appointment-status"
import { MedicalProfileTab } from "@/app/(dashboard)/patients/[id]/medical-profile-tab"
import { PatientTimeline } from "@/app/(dashboard)/patients/[id]/timeline"
import { ClinicalTabs } from "@/app/(dashboard)/patients/[id]/clinical-tabs"
import { BillingTabs } from "@/app/(dashboard)/patients/[id]/billing-tabs"
import { InsuranceTabs } from "@/app/(dashboard)/patients/[id]/insurance-tabs"
import { PortalAccessCard } from "@/app/(dashboard)/patients/[id]/portal-access-card"
import { PatientStatusControl } from "@/app/(dashboard)/patients/[id]/patient-status-control"
import { NewAppointmentDialog } from "@/app/(dashboard)/appointments/new-appointment-dialog"
import { getPortalAccountForPatient } from "@/lib/domains/portal/service"
import { listMessageHistory } from "@/lib/domains/communications/service"

const LIVE_CLINICAL_TABS = [
  { value: "episodes", label: "Episodes" },
  { value: "encounters", label: "Encounters" },
  { value: "vitals", label: "Vitals" },
  { value: "diagnoses", label: "Diagnoses" },
  { value: "prescriptions", label: "Prescriptions" },
  { value: "orders", label: "Orders" },
  { value: "lab-results", label: "Lab Results" },
  { value: "imaging", label: "Imaging" },
]

const LIVE_BILLING_TABS = [
  { value: "packages", label: "Packages" },
  { value: "invoices", label: "Invoices" },
  { value: "payments", label: "Payments" },
  // P1 §36: one chronological ledger of invoices/payments/refunds with a
  // running balance, reconciled to AR — see billing/statement.ts.
  { value: "statement", label: "Statement" },
  { value: "insurance", label: "Insurance" },
  { value: "communications", label: "Communications" },
]

const FUTURE_TABS: { value: string; label: string; phase: string }[] = [
  { value: "documents", label: "Documents", phase: "a later phase (see BLUEPRINT.md scoping note)" },
]

export default async function PatientProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession()
  if (!session || !can(session, "patient.view")) redirect("/dashboard")

  const { id } = await params
  const canBookAppointment = can(session, "appointment.create")
  // P3.2 §7: `listPatientAppointments` requires `appointment.view`, which
  // Cashier, Laboratory Technician, Pharmacist, and Radiology Technician do
  // not hold in the seeded role permissions even though all four hold
  // `patient.view` — confirmed by reading prisma/seed.ts directly. Before
  // this gate, opening any patient's profile as one of those roles threw a
  // ForbiddenError in this top-level Promise.all, before the page even
  // reached Tabs — the whole page failed, not just the Appointments tab.
  const canViewAppointments = can(session, "appointment.view")
  // P3.13: `appointment.create` says nothing about whether the session can
  // call listProviders/listServices (provider.view/service.view
  // respectively) — Receptionist has appointment.create but no
  // provider.view/service.view gating issue since those two ARE held; the
  // branch options previously went through the org-wide `branch.view`-gated
  // `listBranches`, which Receptionist does NOT hold — this didn't crash
  // the page (the fetch was already conditionally skipped), but silently
  // left the "Book appointment" dialog's Branch dropdown completely empty,
  // making booking impossible from this entry point for the exact role
  // whose job this is. Reproduced live during P3.13's own browser
  // walkthrough. Fixed the same way P3.1 already fixed the identical class
  // of bug for reception/page.tsx, appointments/page.tsx, and queue/page.tsx:
  // `listAccessibleBranches` needs no permission beyond branchIds on the
  // session, so the branch options are now always fetched whenever booking
  // is possible at all, with no separate permission gate.
  const canViewProviderOptions = canBookAppointment && can(session, "provider.view")
  const canViewServiceOptions = canBookAppointment && can(session, "service.view")
  // P3.2 §6/§9/§28: the billing statement is now fetched once here (instead
  // of inside BillingTabs) so it can also power the Overview tab's
  // permission-gated "Financial snapshot" — a real net-zero on query count
  // (moved, not duplicated), not a new round trip.
  const canViewStatement = can(session, "invoice.view") && can(session, "payment.view")
  const [patient, appointments, labResults, imagingResults, portalAccount, branches, providers, services, statement] = await Promise.all([
    // Targeted backlog closure, item 4 — see loadOrNotFound's own doc comment.
    loadOrNotFound(() => getPatient(session, id)),
    canViewAppointments ? listPatientAppointments(session, id) : Promise.resolve([]),
    listPatientLabResults(session, id),
    listPatientImagingResults(session, id),
    can(session, "patient.edit") ? getPortalAccountForPatient(session, id) : Promise.resolve(null),
    // P3.2: only fetched when the session can actually use them — powers
    // the "Book appointment" quick action below, wiring up
    // NewAppointmentDialog's own defaultPatientId/defaultPatientLabel
    // props, which existed but had no caller anywhere in the app before
    // this batch.
    canBookAppointment ? listAccessibleBranches(session) : Promise.resolve([]),
    canViewProviderOptions ? listProviders(session) : Promise.resolve([]),
    canViewServiceOptions ? listServices(session) : Promise.resolve([]),
    canViewStatement ? getPatientStatement(session, id) : Promise.resolve(null),
  ])

  // P3.2 §3/§6: "what's happening with this patient now" — built entirely
  // from `appointments`, already fetched above; no extra query.
  const ACTIVE_APPOINTMENT_STATUSES = new Set(["scheduled", "confirmed", "arrived", "checked_in", "waiting", "in_consultation"])
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000)
  const todaysAppointments = appointments.filter((a) => a.startTime >= startOfToday && a.startTime < endOfToday)
  const todayAppointment = todaysAppointments.find((a) => ACTIVE_APPOINTMENT_STATUSES.has(a.status)) ?? todaysAppointments[0] ?? null
  const upcomingAppointment =
    appointments
      .filter((a) => a.startTime > now && ACTIVE_APPOINTMENT_STATUSES.has(a.status))
      .sort((a, b) => a.startTime.getTime() - b.startTime.getTime())[0] ?? null
  // Scoped to one patient — naturally small, no pagination UI needed here.
  const messageHistory = can(session, "communication.send") ? (await listMessageHistory(session, { patientId: id })).messages : []

  const alerts = [
    ...patient.allergies.filter((a) => a.isAlert).map((a) => `Allergy: ${a.allergen}`),
    ...patient.conditions.filter((c) => c.isAlert).map((c) => c.description),
  ]

  // Prisma's Decimal fields can't cross the Server->Client boundary — same
  // plain-field-subset convention appointments/page.tsx and reception/page.tsx
  // already use for these exact two option lists.
  const providerOptions = providers.map((p) => ({
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    defaultAppointmentDurationMinutes: p.defaultAppointmentDurationMinutes,
  }))
  const serviceOptions = services.map((s) => ({ id: s.id, name: s.name, durationMinutes: s.durationMinutes }))

  return (
    <div className="flex flex-col gap-6">
      {/* P4.7A §39 — the patient identity/context bar every patient-related
          screen builds around: name, MRN, age/DOB/gender, contact, and any
          real (schema-modeled) clinical alert — never an invented
          allergy/warning. Clinical alerts get their own visually distinct
          block (icon + text + destructive tone, never color alone, §77). */}
      <Card className="border-l-4 border-l-primary">
        <CardContent className="flex flex-col gap-4 pt-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-foreground">
                {patient.firstName} {patient.middleName ? `${patient.middleName} ` : ""}
                {patient.lastName}
              </h1>
              <Badge variant="outline" className="font-mono">{patient.mrn}</Badge>
              <StatusBadge status={patient.status} />
              {can(session, "patient.edit") && <PatientStatusControl patientId={patient.id} currentStatus={patient.status} />}
            </div>
            <p className="text-sm text-muted-foreground">
              {calculateAge(patient.dob)}y · {patient.gender} · DOB {formatDate(patient.dob)}
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <span className="flex items-center gap-1">
                <Phone className="size-3.5" /> {patient.mobile}
              </span>
              {patient.email && (
                <span className="flex items-center gap-1">
                  <Mail className="size-3.5" /> {patient.email}
                </span>
              )}
              {patient.city && (
                <span className="flex items-center gap-1">
                  <MapPin className="size-3.5" /> {patient.city}
                  {patient.country ? `, ${patient.country}` : ""}
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-col items-start gap-3 sm:items-end">
            {/* P3.2: closes a real front-desk workflow dead end — until now,
                booking a new appointment for a patient already open in
                Patient 360 meant navigating away to Reception/Appointments
                and re-searching for the same patient by hand. */}
            {canBookAppointment && (
              <NewAppointmentDialog
                branches={branches}
                providers={providerOptions}
                services={serviceOptions}
                defaultBranchId={patient.registrationBranchId}
                defaultPatientId={patient.id}
                defaultPatientLabel={`${patient.firstName} ${patient.lastName}`}
              />
            )}
            {alerts.length > 0 && (
              <div className="flex flex-col gap-1 rounded-md border border-destructive-border bg-destructive-surface p-3">
                {alerts.map((alert, i) => (
                  <span key={i} className="flex items-center gap-2 text-sm font-medium text-destructive">
                    <AlertTriangle className="size-4 shrink-0" /> {alert}
                  </span>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="overview">
        {/* P3.2 §32: the shared `TabsList` hard-codes a single-row `h-8` and
            each trigger's active-state pill is `h-[calc(100%-1px)]` of that
            row — the app-wide `className="flex-wrap"` convention (used
            identically on 4 other pages: portal, communications, reports,
            accounting) wraps the *trigger buttons* onto extra rows without
            growing that height, so on Patient 360 (13 tabs, the most of any
            page using this convention) the wrapped rows visibly overlapped
            the Overview tab's own content underneath — confirmed live in
            the browser at the pane's ~800px width, and an attempted local
            height override still left the active-tab pill stretching across
            all wrapped rows, since `TabsTrigger`'s sizing assumes one row.
            Properly supporting a multi-row TabsList belongs in the shared
            `ui/tabs.tsx` primitive (affects the other 4 pages too — flagged
            in BACKLOG.md) rather than diverging Patient 360 from the same
            convention with a one-off hack. Scrolling horizontally in a
            single row sidesteps the row-height assumption entirely and
            needs no primitive change. */}
        {/* P4.7A §40 — 13 tabs grouped into 4 recognizable clusters (Core,
            Clinical, Financial, Engagement) via a thin vertical separator
            between groups, rather than one undifferentiated row. No tab
            was removed, renamed, or moved to a secondary/hidden menu — the
            same horizontal-scroll-in-one-row mechanism the pre-existing
            comment below documents (a real `ui/tabs.tsx` primitive
            limitation with multi-row wrapping, tracked in BACKLOG.md,
            affecting 4 other pages too) still applies; grouping is a purely
            visual improvement layered on top of it, not a fix for it. */}
        <TabsList className="w-full flex-nowrap justify-start gap-1 overflow-x-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <Separator orientation="vertical" className="mx-1 h-5 self-center" />
          <TabsTrigger value="medical">Medical Profile</TabsTrigger>
          <TabsTrigger value="appointments">Appointments</TabsTrigger>
          {LIVE_CLINICAL_TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
          <Separator orientation="vertical" className="mx-1 h-5 self-center" />
          {LIVE_BILLING_TABS.slice(0, -1).map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
          <Separator orientation="vertical" className="mx-1 h-5 self-center" />
          {LIVE_BILLING_TABS.slice(-1).map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
          {FUTURE_TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview" className="grid gap-4 sm:grid-cols-2">
          {/* P3.2 §3/§6/§9: "what's happening with this patient now" and "what
              should I do next" previously required opening the Appointments
              tab (or, for billing, the Statement tab) even though the data
              needed to answer both was already being fetched on this page.
              Built entirely from `appointments` (already fetched above) and
              the `statement` now fetched once at the top of this page — no
              new queries. */}
          <Card className="sm:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">Current Status</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <p className="mb-1 text-muted-foreground">Today</p>
                {!canViewAppointments ? (
                  <p className="text-muted-foreground">—</p>
                ) : todayAppointment ? (
                  <div className="grid gap-1">
                    <Link href={`/appointments/${todayAppointment.id}`} className="font-medium hover:underline">
                      {formatDateTime(todayAppointment.startTime)} · {todayAppointment.provider.firstName} {todayAppointment.provider.lastName}
                    </Link>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={todayAppointment.status} label={APPOINTMENT_STATUS_LABEL[todayAppointment.status]} />
                      {todayAppointment.queueEntry && (
                        <span className="text-muted-foreground">Token {todayAppointment.queueEntry.tokenNumber}</span>
                      )}
                      {todayAppointment.encounter && (
                        <span className="text-muted-foreground">
                          Encounter {todayAppointment.encounter.encounterNumber} ({todayAppointment.encounter.status})
                        </span>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="text-muted-foreground">No appointment today.</p>
                )}
              </div>
              <div>
                <p className="mb-1 text-muted-foreground">Upcoming appointment</p>
                {!canViewAppointments ? (
                  <p className="text-muted-foreground">—</p>
                ) : upcomingAppointment ? (
                  <Link href={`/appointments/${upcomingAppointment.id}`} className="font-medium hover:underline">
                    {formatDateTime(upcomingAppointment.startTime)} · {upcomingAppointment.service?.name ?? "—"}
                  </Link>
                ) : (
                  <p className="text-muted-foreground">None scheduled.</p>
                )}
              </div>
              {canViewStatement && statement && (
                <div>
                  <p className="mb-1 text-muted-foreground">Financial snapshot</p>
                  <div className="flex items-center gap-2">
                    <span className="font-medium tabular-nums">Outstanding: {statement.outstandingBalance.toFixed(2)}</span>
                    {!statement.reconciled && <StatusBadge status="attention_required" label="Does not reconcile" />}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Demographics</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-1.5 text-sm">
              <Row label="Nationality" value={patient.nationality} />
              <Row label="National ID" value={patient.nationalId} />
              <Row label="Passport" value={patient.passportNumber} />
              <Row label="Preferred language" value={patient.preferredLanguage} />
              <Row label="Referral source" value={patient.referralSource} />
              <Row label="Preferred provider" value={patient.preferredProvider ? `${patient.preferredProvider.firstName} ${patient.preferredProvider.lastName}` : null} />
              <Row label="Registration branch" value={patient.registrationBranch.name} />
              <Row label="Registered" value={formatDate(patient.createdAt)} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Emergency Contact</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-1.5 text-sm">
              <Row label="Name" value={patient.emergencyContactName} />
              <Row label="Relationship" value={patient.emergencyContactRelationship} />
              <Row label="Phone" value={patient.emergencyContactPhone} />
            </CardContent>
          </Card>
          {can(session, "patient.edit") && (
            <PortalAccessCard patientId={id} account={portalAccount ? { email: portalAccount.email, status: portalAccount.status } : null} />
          )}
        </TabsContent>

        <TabsContent value="timeline">
          <PatientTimeline
            patient={patient}
            appointments={appointments}
            statementLines={canViewStatement && statement ? statement.lines : []}
          />
        </TabsContent>

        <TabsContent value="medical">
          <MedicalProfileTab patient={patient} canEdit={can(session, "patient.edit")} />
        </TabsContent>

        <TabsContent value="appointments">
          {!canViewAppointments ? (
            <p className="text-sm text-muted-foreground">You don&apos;t have permission to view appointments.</p>
          ) : (
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>Date/Time</TableHead>
                    <TableHead>Branch</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>Service</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {appointments.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="p-0">
                        <EmptyState title="No appointments yet" className="border-none" />
                      </TableCell>
                    </TableRow>
                  )}
                  {appointments.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell>
                        <Link href={`/appointments/${a.id}`} className="hover:underline">
                          {a.appointmentNumber}
                        </Link>
                      </TableCell>
                      <TableCell>{formatDateTime(a.startTime)}</TableCell>
                      <TableCell>{a.branch.name}</TableCell>
                      <TableCell>
                        {a.provider.firstName} {a.provider.lastName}
                      </TableCell>
                      <TableCell>{a.service?.name ?? "—"}</TableCell>
                      <TableCell>
                        <StatusBadge status={a.status} label={APPOINTMENT_STATUS_LABEL[a.status]} />
                        {/* P3.1 §14: makes the reschedule relationship visible from Patient 360 too, not just the detail page. */}
                        {a.rescheduledTo[0] && (
                          <Link href={`/appointments/${a.rescheduledTo[0].id}`} className="ml-2 text-xs text-muted-foreground hover:underline">
                            → {a.rescheduledTo[0].appointmentNumber}
                          </Link>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          )}
        </TabsContent>

        <ClinicalTabs session={session} patientId={id} />

        <TabsContent value="lab-results">
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Verified</TableHead>
                    <TableHead>Test</TableHead>
                    <TableHead>Result</TableHead>
                    <TableHead>Range</TableHead>
                    <TableHead>Flag</TableHead>
                    <TableHead>Order</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {labResults.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="p-0">
                        <EmptyState title="No verified lab results yet" className="border-none" />
                      </TableCell>
                    </TableRow>
                  )}
                  {labResults.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{r.verifiedAt ? formatDate(r.verifiedAt) : "—"}</TableCell>
                      <TableCell className="font-medium">{r.labTest.name}</TableCell>
                      <TableCell>{r.numericValue != null ? `${r.numericValue} ${r.unit ?? ""}` : r.textValue ?? "—"}</TableCell>
                      <TableCell>
                        {r.referenceRangeLow != null && r.referenceRangeHigh != null
                          ? `${r.referenceRangeLow}–${r.referenceRangeHigh}`
                          : r.referenceRangeText ?? "—"}
                      </TableCell>
                      <TableCell>
                        {r.abnormalFlag && r.abnormalFlag !== "normal" && <StatusBadge status={r.abnormalFlag} />}
                      </TableCell>
                      <TableCell>
                        <Link href={`/laboratory/orders/${r.clinicalOrder.id}`} className="hover:underline">
                          {r.clinicalOrder.orderNumber}
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="imaging">
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Verified</TableHead>
                    <TableHead>Study</TableHead>
                    <TableHead>Impression</TableHead>
                    <TableHead>Order</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {imagingResults.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="p-0">
                        <EmptyState title="No verified imaging results yet" className="border-none" />
                      </TableCell>
                    </TableRow>
                  )}
                  {imagingResults.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{r.verifiedAt ? formatDate(r.verifiedAt) : "—"}</TableCell>
                      <TableCell className="font-medium">{r.imagingService.name}</TableCell>
                      <TableCell>{r.impression ?? "—"}</TableCell>
                      <TableCell>
                        <Link href={`/radiology/orders/${r.clinicalOrder.id}`} className="hover:underline">
                          {r.clinicalOrder.orderNumber}
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <BillingTabs session={session} patientId={id} branchId={patient.registrationBranchId} statement={statement} canViewStatement={canViewStatement} />
        <InsuranceTabs session={session} patientId={id} />

        <TabsContent value="communications">
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Sent</TableHead>
                    <TableHead>Channel</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Message</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {messageHistory.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="p-0">
                        <EmptyState title="No messages sent to this patient yet" className="border-none" />
                      </TableCell>
                    </TableRow>
                  )}
                  {messageHistory.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell>{formatDateTime(m.createdAt)}</TableCell>
                      <TableCell className="capitalize">{m.channel}</TableCell>
                      <TableCell>
                        <StatusBadge status={m.status} />
                      </TableCell>
                      <TableCell className="max-w-md text-muted-foreground">{m.error ?? m.body}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {FUTURE_TABS.map((tab) => (
          <TabsContent key={tab.value} value={tab.value}>
            <ComingSoon label={tab.label} phase={tab.phase} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value || "—"}</span>
    </div>
  )
}
