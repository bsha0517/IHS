import Link from "next/link"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { getPrescriptionForDispensing } from "@/lib/domains/pharmacy/queue"
import { listMedications } from "@/lib/domains/pharmacy/medications"
import { listStockSummary } from "@/lib/domains/inventory/stock"
import { getPatient } from "@/lib/domains/patients/service"
import { formatDate, formatDateTime } from "@/lib/utils/dates"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { StatusBadge } from "@/components/ui/status-badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { TriangleAlert } from "lucide-react"
import { DispenseItemDialog } from "@/app/(dashboard)/pharmacy/[id]/dispense-item-dialog"
import { VerifyButton, DispenseButton } from "@/app/(dashboard)/pharmacy/[id]/dispensing-actions"
import { ReturnDialog } from "@/app/(dashboard)/pharmacy/[id]/return-dialog"

// Prescription.status ("active"/"completed"/"cancelled") shown as
// "active"/"dispensed"/"cancelled" — the same operational vocabulary the
// Pharmacy Queue page uses, matching real model states (§6/§27), not an
// invented presentation label.
const STATUS_LABEL: Record<string, string> = { active: "active", completed: "dispensed", cancelled: "cancelled" }

export default async function PrescriptionDispensingPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession()
  // P3.6 §37: widened from `prescription.dispense` alone so a Doctor (who
  // only holds `encounter.view`, not the pharmacy-ops permission) has a
  // real, working destination when the Encounter links here — see
  // `getPrescriptionForDispensing`'s own comment for the full reasoning.
  // `canOperate` below still gates every actual dispensing action.
  if (!session || (!can(session, "prescription.dispense") && !can(session, "encounter.view"))) redirect("/dashboard")

  const { id } = await params
  const canOperate = can(session, "prescription.dispense")
  const canVerify = can(session, "prescription.verify")
  const canViewPatient = can(session, "patient.view")
  const prescription = await getPrescriptionForDispensing(session, id)
  // `listMedications`/`listStockSummary` both require `inventory.view`,
  // which Doctor doesn't hold — only fetched when the session can actually
  // act on this page, the same defensive-loading class of fix P3.2/P3.5
  // already established for this exact "widen the read, still crash on an
  // unconditional operational fetch" pitfall. `getPatient` similarly
  // guarded on `patient.view` rather than assumed from the page's own gate.
  const [medications, stock, patient] = await Promise.all([
    canOperate ? listMedications(session) : Promise.resolve([]),
    canOperate ? listStockSummary(session, prescription.encounter.branchId) : Promise.resolve([]),
    // P3.6 §39: informational only — Pharmacy may display existing allergy
    // alerts, never an automated interaction check against what's being
    // dispensed (explicitly out of scope; see the report's Drug Safety
    // section).
    canViewPatient ? getPatient(session, prescription.patientId) : Promise.resolve(null),
  ])

  // P3.6 §12: real branch-local stock shown before dispensing — one bulk
  // `listStockSummary` call (a single groupBy query across every product at
  // this branch), not a per-medication balance lookup, so this stays flat
  // regardless of how many medications the catalog holds (§41).
  const balanceByProduct = new Map(stock.map((p) => [p.id, p.balance]))
  const medicationOptions = medications.map((m) => ({
    id: m.id,
    // Targeted backlog closure, item 8: the raw product name, separate from
    // `label`'s display formatting — the client dialog compares this
    // against the prescribed medication name to decide whether to show the
    // substitution-confirmation warning.
    name: m.product.name,
    label: `${m.product.name}${m.strength ? ` ${m.strength}` : ""}`,
    balance: balanceByProduct.get(m.productId) ?? 0,
  }))

  return (
    <div className="flex flex-col gap-6">
      {/* P4.7A.1 §19 — the pharmacist must immediately see who this is for,
          what was prescribed, and its current status before touching a
          single dispensing control — the same context-bar language used
          on Patient 360 and the Doctor consultation workspace. */}
      <Card className="border-l-4 border-l-primary">
        <CardContent className="flex flex-col gap-2 pt-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">{prescription.prescriptionNumber}</h1>
              <StatusBadge status={prescription.status} label={STATUS_LABEL[prescription.status]} />
            </div>
            <p className="text-sm text-muted-foreground">
              {canViewPatient ? (
                <Link href={`/patients/${prescription.patientId}`} className="font-medium text-foreground hover:underline">
                  {prescription.patient.firstName} {prescription.patient.lastName}
                </Link>
              ) : (
                <span className="font-medium text-foreground">
                  {prescription.patient.firstName} {prescription.patient.lastName}
                </span>
              )}
              {" · "}Prescribed by {prescription.provider.firstName} {prescription.provider.lastName} ·{" "}
              {formatDate(prescription.issuedAt)} · {prescription.encounter.branch.name}
            </p>
          </div>
        </CardContent>
      </Card>

      {patient != null && patient.allergies.some((a) => a.status === "active") && (
        <Alert variant="destructive">
          <TriangleAlert className="size-4" />
          <AlertDescription>
            Known allergies:{" "}
            {patient.allergies
              .filter((a) => a.status === "active")
              .map((a) => a.allergen)
              .join(", ")}{" "}
            — informational only, not an automated interaction check.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Prescribed items</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {prescription.items.map((item) => (
            <div key={item.id} className="rounded-md border border-border p-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-medium">
                    {item.medicationName} {item.strength ?? ""}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {item.dose} · {item.frequency} · {item.route}
                    {item.durationDays ? ` · ${item.durationDays} days` : ""}
                    {item.quantity != null ? ` · qty ${item.quantity}` : ""}
                  </p>
                  {item.instructions && <p className="text-sm text-muted-foreground">{item.instructions}</p>}
                </div>
                <div className="flex flex-col items-end gap-2 text-sm">
                  <span className="text-muted-foreground">
                    {item.dispensedQuantity} dispensed{item.remainingQuantity != null ? ` · ${item.remainingQuantity} remaining` : ""}
                  </span>
                  {canOperate && prescription.status === "active" && (item.remainingQuantity == null || item.remainingQuantity > 0) && (
                    <DispenseItemDialog
                      prescriptionId={prescription.id}
                      prescriptionItemId={item.id}
                      medications={medicationOptions}
                      prescribed={{
                        medicationName: item.medicationName,
                        strength: item.strength,
                        dose: item.dose,
                        route: item.route,
                        frequency: item.frequency,
                      }}
                    />
                  )}
                </div>
              </div>

              {item.dispensingRecords.length > 0 && (
                <Table className="mt-3">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Dispensing #</TableHead>
                      <TableHead>Medication</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Returned</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {item.dispensingRecords.map((d) => {
                      const returned = d.returns.reduce((sum, r) => sum + r.quantityReturned, 0)
                      return (
                        <TableRow key={d.id}>
                          <TableCell>{d.dispensingNumber}</TableCell>
                          <TableCell>{d.medication.product.name}</TableCell>
                          <TableCell className="text-right">{d.quantityDispensed}</TableCell>
                          <TableCell>
                            <StatusBadge status={d.status} />
                          </TableCell>
                          <TableCell>{returned > 0 ? returned : "—"}</TableCell>
                          <TableCell className="flex justify-end gap-2">
                            {d.status === "pending" && canVerify && (
                              <VerifyButton dispensingRecordId={d.id} prescriptionId={prescription.id} />
                            )}
                            {d.status === "verified" && canOperate && (
                              <DispenseButton dispensingRecordId={d.id} prescriptionId={prescription.id} />
                            )}
                            {d.status === "dispensed" && canOperate && returned < d.quantityDispensed && (
                              <ReturnDialog
                                dispensingRecordId={d.id}
                                prescriptionId={prescription.id}
                                maxReturnable={d.quantityDispensed - returned}
                              />
                            )}
                            {d.dispensedAt && <span className="text-xs text-muted-foreground self-center">{formatDateTime(d.dispensedAt)}</span>}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
