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
import { listBranches } from "@/lib/domains/identity/org-structure"
import { listProviders } from "@/lib/domains/providers/service"
import type { SessionContext } from "@/lib/auth/session"
import { NewEpisodeDialog } from "@/app/(dashboard)/patients/[id]/new-episode-dialog"
import { NewStandaloneEncounterDialog } from "@/app/(dashboard)/patients/[id]/new-encounter-dialog"

export async function ClinicalTabs({ session, patientId }: { session: SessionContext; patientId: string }) {
  const [episodes, encounters, vitals, diagnoses, prescriptions, orders, branches, providers] = await Promise.all([
    listPatientEpisodes(session, patientId),
    listPatientEncounters(session, patientId),
    listPatientVitals(session, patientId),
    listPatientDiagnoses(session, patientId),
    listPatientPrescriptions(session, patientId),
    listPatientOrders(session, patientId),
    listBranches(session),
    listProviders(session),
  ])

  const canCreateEncounter = can(session, "encounter.create")
  const providerOptions = providers.map((p) => ({ id: p.id, firstName: p.firstName, lastName: p.lastName }))

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
                    <TableCell colSpan={7} className="text-center text-muted-foreground">
                      No vitals recorded.
                    </TableCell>
                  </TableRow>
                )}
                {vitals.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell>{formatDateTime(v.recordedAt)}</TableCell>
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
                </TableRow>
              </TableHeader>
              <TableBody>
                {diagnoses.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground">
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
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {prescriptions.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
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
                      <Badge variant={rx.status === "active" ? "default" : "secondary"}>{rx.status}</Badge>
                    </TableCell>
                    <TableCell>
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
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground">
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
