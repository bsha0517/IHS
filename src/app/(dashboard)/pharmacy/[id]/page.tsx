import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { getPrescriptionForDispensing } from "@/lib/domains/pharmacy/queue"
import { listMedications } from "@/lib/domains/pharmacy/medications"
import { formatDate, formatDateTime } from "@/lib/utils/dates"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { DispenseItemDialog } from "@/app/(dashboard)/pharmacy/[id]/dispense-item-dialog"
import { VerifyButton, DispenseButton } from "@/app/(dashboard)/pharmacy/[id]/dispensing-actions"
import { ReturnDialog } from "@/app/(dashboard)/pharmacy/[id]/return-dialog"

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  verified: "secondary",
  dispensed: "default",
  cancelled: "destructive",
}

export default async function PrescriptionDispensingPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession()
  if (!session || !can(session, "prescription.dispense")) redirect("/dashboard")

  const { id } = await params
  const canVerify = can(session, "prescription.verify")
  const [prescription, medications] = await Promise.all([getPrescriptionForDispensing(session, id), listMedications(session)])

  const medicationOptions = medications.map((m) => ({ id: m.id, label: `${m.product.name}${m.strength ? ` ${m.strength}` : ""}` }))

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{prescription.prescriptionNumber}</h1>
        <p className="text-sm text-muted-foreground">
          {prescription.patient.firstName} {prescription.patient.lastName} · Prescribed by {prescription.provider.firstName}{" "}
          {prescription.provider.lastName} · {formatDate(prescription.issuedAt)}
        </p>
      </div>

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
                  {prescription.status === "active" && (item.remainingQuantity == null || item.remainingQuantity > 0) && (
                    <DispenseItemDialog prescriptionId={prescription.id} prescriptionItemId={item.id} medications={medicationOptions} />
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
                            <Badge variant={STATUS_VARIANT[d.status] ?? "outline"}>{d.status}</Badge>
                          </TableCell>
                          <TableCell>{returned > 0 ? returned : "—"}</TableCell>
                          <TableCell className="flex justify-end gap-2">
                            {d.status === "pending" && canVerify && (
                              <VerifyButton dispensingRecordId={d.id} prescriptionId={prescription.id} />
                            )}
                            {d.status === "verified" && <DispenseButton dispensingRecordId={d.id} prescriptionId={prescription.id} />}
                            {d.status === "dispensed" && returned < d.quantityDispensed && (
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
