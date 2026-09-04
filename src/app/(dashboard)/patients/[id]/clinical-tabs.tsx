import Link from "next/link"
import { TabsContent } from "@/components/ui/tabs"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatDate, formatDateTime } from "@/lib/utils/dates"
import { can } from "@/lib/platform/permissions-core"
import { listPatientEpisodes } from "@/lib/domains/clinical/episodes"
import { listPatientEncounters } from "@/lib/domains/clinical/encounters"
import { listPatientVitals } from "@/lib/domains/clinical/vitals"
import { listPatientDiagnoses } from "@/lib/domains/clinical/diagnoses"
import { listPatientPrescriptions } from "@/lib/domains/clinical/prescriptions"
import { listPatientOrders } from "@/lib/domains/clinical/orders"
import { listAccessibleBranches } from "@/lib/domains/billing/cashier"
import { listProviders } from "@/lib/domains/providers/service"
import type { SessionContext } from "@/lib/auth/session"
import { NewEpisodeDialog } from "@/app/(dashboard)/patients/[id]/new-episode-dialog"
import { NewStandaloneEncounterDialog } from "@/app/(dashboard)/patients/[id]/new-encounter-dialog"

// Same operational vocabulary as the Pharmacy Queue/Encounter — real model
// states (active/completed/cancelled), never an invented label.
const PRESCRIPTION_STATUS_LABEL: Record<string, string> = { active: "active", completed: "dispensed", cancelled: "cancelled" }

/** P3.6 §29: the same "still open" derivation the Pharmacy Queue and
 * Encounter's own PrescriptionsSection both use — one definition of
 * fulfillment, not a third competing one. */
function summarizeFulfillment(items: { quantity: number | null; dispensingRecords: { status: string; quantityDispensed: number }[] }[]) {
  let anyDispensed = false
  let anyOutstanding = false
  for (const item of items) {
    const dispensed = item.dispensingRecords.filter((d) => d.status !== "cancelled").reduce((sum, d) => sum + d.quantityDispensed, 0)
    if (dispensed > 0) anyDispensed = true
    if (item.quantity == null || dispensed < item.quantity) anyOutstanding = true
  }
  if (!anyDispensed) return "Not yet dispensed"
  if (anyOutstanding) return "Partially dispensed"
  return "Fully dispensed"
}

const CLINICAL_TAB_VALUES = ["episodes", "encounters", "vitals", "diagnoses", "prescriptions", "orders"] as const

/**
 * P3.2 §7/§13: every one of the six `listPatient*` calls below requires
 * `encounter.view` — before this gate, ALL of Episodes/Encounters/Vitals/
 * Diagnoses/Prescriptions/Orders were fetched unconditionally the instant
 * Patient 360 rendered. Per the seeded role permission sets (prisma/seed.ts),
 * only Doctor, Nurse, and the two admin roles hold `encounter.view` —
 * Receptionist, Cashier, Clinic Manager, Laboratory Technician, Pharmacist,
 * and Radiology Technician do not, even though every one of them holds
 * `patient.view` and can open any patient's profile. Every one of those
 * roles hit a thrown `ForbiddenError` here with no catch anywhere in the
 * tree, which the nearest route error boundary turned into a full-page
 * "Something went wrong" for the entire Patient 360 page — not just this
 * tab. Confirmed by reading the seeded permission lists directly, not
 * assumed. Fixed the same way InsuranceTabs already guards `coverage.manage`.
 */
export async function ClinicalTabs({ session, patientId }: { session: SessionContext; patientId: string }) {
  const canViewClinical = can(session, "encounter.view")
  const canCreateEncounter = can(session, "encounter.create")
  // Dialog option lists — also unconditional before the original fix, and
  // gated on the wrong permission (`encounter.create` says nothing about
  // whether the session can call listProviders, which needs `provider.view`).
  // P3.13: the branch half of this was gated on the org-wide `branch.view`
  // (via `listBranches`) — Doctor/Nurse hold `encounter.create` but not
  // `branch.view` in the seed data, so this didn't crash the page (the
  // fetch was already conditional) but left the New Episode/New Encounter
  // dialogs' Branch dropdown silently empty, making a walk-in
  // episode/encounter (not tied to an existing appointment) impossible to
  // start — reproduced live during P3.13's own browser walkthrough.
  // Switched to `listAccessibleBranches` (no permission beyond branchIds
  // needed), the same fix already applied to reception/page.tsx,
  // appointments/page.tsx, queue/page.tsx, and patients/[id]/page.tsx.
  const canViewProviderOptions = canCreateEncounter && can(session, "provider.view")

  const [episodes, encounters, vitals, diagnoses, prescriptions, orders, branches, providers] = await Promise.all([
    canViewClinical ? listPatientEpisodes(session, patientId) : Promise.resolve([]),
    canViewClinical ? listPatientEncounters(session, patientId) : Promise.resolve([]),
    canViewClinical ? listPatientVitals(session, patientId) : Promise.resolve([]),
    canViewClinical ? listPatientDiagnoses(session, patientId) : Promise.resolve([]),
    canViewClinical ? listPatientPrescriptions(session, patientId) : Promise.resolve([]),
    canViewClinical ? listPatientOrders(session, patientId) : Promise.resolve([]),
    canCreateEncounter ? listAccessibleBranches(session) : Promise.resolve([]),
    canViewProviderOptions ? listProviders(session) : Promise.resolve([]),
  ])

  const providerOptions = providers.map((p) => ({ id: p.id, firstName: p.firstName, lastName: p.lastName }))

  if (!canViewClinical) {
    return (
      <>
        {CLINICAL_TAB_VALUES.map((value) => (
          <TabsContent key={value} value={value}>
            <p className="text-sm text-muted-foreground">You don&apos;t have permission to view clinical records.</p>
          </TabsContent>
        ))}
      </>
    )
  }

  return (
    <>
      <TabsContent value="episodes">
        <Card>
          <CardContent className="pt-6">
            {canCreateEncounter && (
              <div className="mb-4 flex justify-end">
                <NewEpisodeDialog patientId={patientId} branches={branches} />
              </div>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {episodes.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground">
                      No episodes yet.
                    </TableCell>
                  </TableRow>
                )}
                {episodes.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>{e.episodeNumber}</TableCell>
                    <TableCell>{e.title}</TableCell>
                    <TableCell>{e.episodeType}</TableCell>
                    <TableCell>{formatDate(e.startDate)}</TableCell>
                    <TableCell>
                      <Badge variant={e.status === "open" || e.status === "active" ? "outline" : "secondary"}>{e.status}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="encounters">
        <Card>
          <CardContent className="pt-6">
            {canCreateEncounter && (
              <div className="mb-4 flex justify-end">
                <NewStandaloneEncounterDialog
                  patientId={patientId}
                  episodes={episodes}
                  branches={branches}
                  providers={providerOptions}
                />
              </div>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {encounters.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground">
                      No encounters yet.
                    </TableCell>
                  </TableRow>
                )}
                {encounters.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>
                      <Link href={`/encounters/${e.id}`} className="hover:underline">
                        {e.encounterNumber}
                      </Link>
                    </TableCell>
                    <TableCell>{e.encounterType.replace("_", " ")}</TableCell>
                    <TableCell>
                      {e.provider.firstName} {e.provider.lastName}
                    </TableCell>
                    <TableCell>{formatDateTime(e.startAt)}</TableCell>
                    <TableCell>
                      <Badge variant={e.status === "finalized" ? "default" : "outline"}>{e.status}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="vitals">
        <Card>
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Recorded</TableHead>
                  <TableHead>Recorded by</TableHead>
                  <TableHead>Height/Weight</TableHead>
                  <TableHead>BMI</TableHead>
                  <TableHead>BP</TableHead>
                  <TableHead>Pulse</TableHead>
                  <TableHead>Temp</TableHead>
                  <TableHead>SpO2</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {vitals.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground">
                      No vitals recorded.
                    </TableCell>
                  </TableRow>
                )}
                {vitals.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell>{formatDateTime(v.recordedAt)}</TableCell>
                    <TableCell>{v.recordedByUser ? `${v.recordedByUser.firstName} ${v.recordedByUser.lastName}` : "—"}</TableCell>
                    <TableCell>
                      {v.heightCm ? `${v.heightCm}cm` : "—"} / {v.weightKg ? `${v.weightKg}kg` : "—"}
                    </TableCell>
                    <TableCell>{v.bmi ? String(v.bmi) : "—"}</TableCell>
                    <TableCell>{v.bloodPressureSystolic ? `${v.bloodPressureSystolic}/${v.bloodPressureDiastolic}` : "—"}</TableCell>
                    <TableCell>{v.pulseBpm ?? "—"}</TableCell>
                    <TableCell>{v.temperatureCelsius ? `${v.temperatureCelsius}°C` : "—"}</TableCell>
                    <TableCell>{v.oxygenSaturationPercent ? `${v.oxygenSaturationPercent}%` : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="diagnoses">
        <Card>
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Encounter</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {diagnoses.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground">
                      No diagnoses recorded.
                    </TableCell>
                  </TableRow>
                )}
                {diagnoses.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>{formatDate(d.diagnosedAt)}</TableCell>
                    <TableCell>
                      {d.description} {d.isPrimary && <Badge className="ml-1">Primary</Badge>}
                    </TableCell>
                    <TableCell>{d.code?.code ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant={d.status === "active" ? "outline" : "secondary"}>{d.status.replace("_", " ")}</Badge>
                    </TableCell>
                    {/* P3.2 §13: closes the diagnosis→encounter cross-reference —
                        `/encounters/[id]` already exists and is where every
                        diagnosis was actually recorded. */}
                    <TableCell>
                      <Link href={`/encounters/${d.encounterId}`} className="text-muted-foreground hover:underline">
                        Open
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="prescriptions">
        <Card>
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Dispensing</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {prescriptions.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground">
                      No prescriptions yet.
                    </TableCell>
                  </TableRow>
                )}
                {prescriptions.map((rx) => (
                  <TableRow key={rx.id}>
                    <TableCell>{rx.prescriptionNumber}</TableCell>
                    <TableCell>{formatDate(rx.issuedAt)}</TableCell>
                    <TableCell>
                      {rx.provider.firstName} {rx.provider.lastName}
                    </TableCell>
                    <TableCell>{rx.items.map((i) => i.medicationName).join(", ")}</TableCell>
                    <TableCell>
                      {/* P3.6 §29: cancelled prescriptions stay historically
                          visible here — never removed, never relabeled. */}
                      <Badge variant={rx.status === "completed" ? "default" : rx.status === "cancelled" ? "destructive" : "outline"}>
                        {PRESCRIPTION_STATUS_LABEL[rx.status] ?? rx.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {/* P3.6 §29: closes PROJECT_STATUS.md's own documented
                          Phase 9 gap — "No per-item dispensing status
                          surfaced on Patient 360's existing Prescriptions
                          tab." Links to the same Pharmacy detail page the
                          Encounter now links to — never a dead link. */}
                      <Link href={`/pharmacy/${rx.id}`} className="text-sm hover:underline">
                        {summarizeFulfillment(rx.items)}
                      </Link>
                    </TableCell>
                    <TableCell className="flex justify-end gap-1">
                      {/* P3.2 §13: closes the prescription→encounter cross-reference. */}
                      <Button size="sm" variant="ghost" asChild>
                        <Link href={`/encounters/${rx.encounterId}`}>Encounter</Link>
                      </Button>
                      <Button size="sm" variant="ghost" asChild>
                        <Link href={`/prescriptions/${rx.id}/print`} target="_blank">
                          Print
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="orders">
        <Card>
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Ordered</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Encounter</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      No orders yet.
                    </TableCell>
                  </TableRow>
                )}
                {orders.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell>{o.orderNumber}</TableCell>
                    <TableCell className="capitalize">{o.orderType}</TableCell>
                    <TableCell className="capitalize">{o.priority}</TableCell>
                    <TableCell>{formatDateTime(o.orderedAt)}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{o.status.replace("_", " ")}</Badge>
                    </TableCell>
                    {/* P3.2 §13: orders have no standalone detail page of their
                        own — same reasoning /orders (the org-wide CPOE log)
                        already documents — they're managed from within their
                        encounter's orders section, verified/lab-results and
                        imaging-results tabs cover the finished-result side. */}
                    <TableCell>
                      <Link href={`/encounters/${o.encounterId}`} className="text-muted-foreground hover:underline">
                        Open
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </TabsContent>
    </>
  )
}
