import Link from "next/link"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listPharmacyQueue } from "@/lib/domains/pharmacy/queue"
import { listMedications } from "@/lib/domains/pharmacy/medications"
import { isPharmacyEnabled } from "@/lib/platform/settings"
import { formatDateTime } from "@/lib/utils/dates"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { MedicationDialog } from "@/app/(dashboard)/pharmacy/medication-dialog"

export default async function PharmacyPage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "prescription.dispense")) redirect("/dashboard")

  const canManageCatalog = can(session, "product.manage")
  const [enabled, queue, medications] = await Promise.all([
    isPharmacyEnabled(session.user.organizationId),
    listPharmacyQueue(session),
    listMedications(session),
  ])

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Pharmacy</h1>

      {!enabled && (
        <Alert variant="destructive">
          <AlertDescription>
            Pharmacy is disabled for this organization. An administrator can re-enable it under Settings.
          </AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger value="queue">Dispensing Queue</TabsTrigger>
          <TabsTrigger value="catalog">Medication Catalog</TabsTrigger>
        </TabsList>

        <TabsContent value="queue" className="grid gap-4">
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Prescription #</TableHead>
                    <TableHead>Patient</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>Items</TableHead>
                    <TableHead>Issued</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queue.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground">
                        No prescriptions awaiting dispensing.
                      </TableCell>
                    </TableRow>
                  )}
                  {queue.map((rx) => (
                    <TableRow key={rx.id}>
                      <TableCell>
                        <Link href={`/pharmacy/${rx.id}`} className="font-medium hover:underline">
                          {rx.prescriptionNumber}
                        </Link>
                      </TableCell>
                      <TableCell>
                        {rx.patient.firstName} {rx.patient.lastName}
                      </TableCell>
                      <TableCell>
                        {rx.provider.firstName} {rx.provider.lastName}
                      </TableCell>
                      <TableCell>
                        {rx.items.length} line{rx.items.length === 1 ? "" : "s"} ·{" "}
                        {rx.items.filter((i) => i.remainingQuantity == null || i.remainingQuantity > 0).length} pending
                      </TableCell>
                      <TableCell>{formatDateTime(rx.issuedAt)}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{rx.status}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="catalog" className="grid gap-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-medium">Medications</h3>
            {canManageCatalog && <MedicationDialog />}
          </div>
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SKU</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Form</TableHead>
                    <TableHead>Strength</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead>Flags</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {medications.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-muted-foreground">
                        No medications in the catalog yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {medications.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell className="font-medium">{m.product.sku}</TableCell>
                      <TableCell>{m.product.name}</TableCell>
                      <TableCell>{m.dosageForm}</TableCell>
                      <TableCell>{m.strength ?? "—"}</TableCell>
                      <TableCell className="text-right">
                        {m.product.sellingPrice != null ? Number(m.product.sellingPrice).toFixed(2) : "—"}
                      </TableCell>
                      <TableCell className="flex gap-1">
                        {m.controlledSubstance && <Badge variant="destructive">Controlled</Badge>}
                        {m.requiresPrescription && <Badge variant="secondary">Rx</Badge>}
                      </TableCell>
                      <TableCell>
                        {canManageCatalog && (
                          <MedicationDialog
                            existing={{
                              id: m.id,
                              sku: m.product.sku,
                              barcode: m.product.barcode,
                              name: m.product.name,
                              category: m.product.category,
                              brand: m.product.brand,
                              unit: m.product.unit,
                              purchaseCost: Number(m.product.purchaseCost),
                              sellingPrice: m.product.sellingPrice != null ? Number(m.product.sellingPrice) : null,
                              reorderLevel: m.product.reorderLevel,
                              minimumStock: m.product.minimumStock,
                              maximumStock: m.product.maximumStock,
                              genericName: m.genericName,
                              strength: m.strength,
                              dosageForm: m.dosageForm,
                              route: m.route,
                              controlledSubstance: m.controlledSubstance,
                              requiresPrescription: m.requiresPrescription,
                            }}
                          />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
