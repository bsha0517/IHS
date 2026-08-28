import Link from "next/link"
import { redirect } from "next/navigation"
import { AlertTriangle, Phone, Mail, MapPin } from "lucide-react"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { getPatient } from "@/lib/domains/patients/service"
import { listPatientAppointments } from "@/lib/domains/appointments/service"
import { listPatientLabResults } from "@/lib/domains/laboratory/results"
import { listPatientImagingResults } from "@/lib/domains/radiology/results"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ComingSoon } from "@/components/layout/coming-soon"
import { calculateAge, formatDate, formatDateTime } from "@/lib/utils/dates"
import { MedicalProfileTab } from "@/app/(dashboard)/patients/[id]/medical-profile-tab"
import { PatientTimeline } from "@/app/(dashboard)/patients/[id]/timeline"
import { ClinicalTabs } from "@/app/(dashboard)/patients/[id]/clinical-tabs"
import { BillingTabs } from "@/app/(dashboard)/patients/[id]/billing-tabs"
import { InsuranceTabs } from "@/app/(dashboard)/patients/[id]/insurance-tabs"
import { PortalAccessCard } from "@/app/(dashboard)/patients/[id]/portal-access-card"
import { PatientStatusControl } from "@/app/(dashboard)/patients/[id]/patient-status-control"
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
  const [patient, appointments, labResults, imagingResults, portalAccount] = await Promise.all([
    getPatient(session, id),
    listPatientAppointments(session, id),
    listPatientLabResults(session, id),
    listPatientImagingResults(session, id),
    can(session, "patient.edit") ? getPortalAccountForPatient(session, id) : Promise.resolve(null),
  ])
  const messageHistory = can(session, "communication.send") ? await listMessageHistory(session, { patientId: id }) : []

  const alerts = [
    ...patient.allergies.filter((a) => a.isAlert).map((a) => `Allergy: ${a.allergen}`),
    ...patient.conditions.filter((c) => c.isAlert).map((c) => c.description),
  ]

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">
                {patient.firstName} {patient.middleName ? `${patient.middleName} ` : ""}
                {patient.lastName}
              </h1>
              <Badge variant="outline">{patient.mrn}</Badge>
              <Badge variant={patient.status === "active" ? "default" : "secondary"}>{patient.status}</Badge>
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

          {alerts.length > 0 && (
            <div className="flex flex-col gap-1 rounded-md border border-destructive/30 bg-destructive/5 p-3">
              {alerts.map((alert, i) => (
                <span key={i} className="flex items-center gap-2 text-sm font-medium text-destructive">
                  <AlertTriangle className="size-4 shrink-0" /> {alert}
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="overview">
        <TabsList className="flex-wrap">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="medical">Medical Profile</TabsTrigger>
          <TabsTrigger value="appointments">Appointments</TabsTrigger>
          {LIVE_CLINICAL_TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
          {LIVE_BILLING_TABS.map((tab) => (
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
          <PatientTimeline patient={patient} appointments={appointments} />
        </TabsContent>

        <TabsContent value="medical">
          <MedicalProfileTab patient={patient} canEdit={can(session, "patient.edit")} />
        </TabsContent>

        <TabsContent value="appointments">
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>Date/Time</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>Service</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {appointments.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground">
                        No appointments yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {appointments.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell>
                        <Link href="/appointments" className="hover:underline">
                          {a.appointmentNumber}
                        </Link>
                      </TableCell>
                      <TableCell>{formatDateTime(a.startTime)}</TableCell>
                      <TableCell>
                        {a.provider.firstName} {a.provider.lastName}
                      </TableCell>
                      <TableCell>{a.service?.name ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{a.status.replace("_", " ")}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
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
                      <TableCell colSpan={6} className="text-center text-muted-foreground">
                        No verified lab results yet.
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
                        {r.abnormalFlag && r.abnormalFlag !== "normal" && (
                          <Badge variant="secondary">{r.abnormalFlag.replace("_", " ")}</Badge>
                        )}
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
                      <TableCell colSpan={4} className="text-center text-muted-foreground">
                        No verified imaging results yet.
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

        <BillingTabs session={session} patientId={id} branchId={patient.registrationBranchId} />
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
                      <TableCell colSpan={4} className="text-center text-muted-foreground">
                        No messages sent to this patient yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {messageHistory.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell>{formatDateTime(m.createdAt)}</TableCell>
                      <TableCell className="capitalize">{m.channel}</TableCell>
                      <TableCell>
                        <Badge variant={m.status === "sent" ? "default" : m.status === "failed" ? "destructive" : "outline"}>{m.status}</Badge>
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
