import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { getAsset } from "@/lib/domains/assets/assets"
import { formatDate } from "@/lib/utils/dates"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { StatusBadge } from "@/components/ui/status-badge"
import { DetailHeader } from "@/components/ui/page-header"
import { MaintenanceDialog } from "@/app/(dashboard)/assets/[id]/maintenance-dialog"
import { CalibrationDialog } from "@/app/(dashboard)/assets/[id]/calibration-dialog"

const RESULT_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
  pass: "default",
  fail: "destructive",
  conditional: "secondary",
}

export default async function AssetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession()
  if (!session || !can(session, "inventory.view")) redirect("/dashboard")

  const { id } = await params
  const canManage = can(session, "asset.manage")
  const asset = await getAsset(session, id)

  return (
    <div className="flex flex-col gap-6">
      <DetailHeader
        module="assets"
        title={asset.name}
        meta={
          <>
            {asset.assetNumber} · {asset.category} · {asset.branch.name}
          </>
        }
        badge={<StatusBadge status={asset.status} />}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Details</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1.5 text-sm">
            <Row label="Branch" value={asset.branch.name} />
            <Row label="Department" value={asset.department?.name} />
            <Row label="Room" value={asset.room?.name} />
            <Row label="Manufacturer" value={asset.manufacturer} />
            <Row label="Model" value={asset.model} />
            <Row label="Serial number" value={asset.serialNumber} />
            <Row label="Assigned to" value={asset.assignedEmployee ? `${asset.assignedEmployee.firstName} ${asset.assignedEmployee.lastName}` : null} />
            <Row label="Supplier" value={asset.supplier?.companyName} />
            <Row label="Purchase date" value={asset.purchaseDate ? formatDate(asset.purchaseDate) : null} />
            <Row label="Cost" value={asset.cost ? Number(asset.cost).toFixed(2) : null} />
            <Row label="Paid via" value={asset.paidVia ?? (asset.cost ? "On credit" : null)} />
            <Row label="Warranty expiry" value={asset.warrantyExpiryDate ? formatDate(asset.warrantyExpiryDate) : null} />
            <Row label="Status" value={asset.status.replace("_", " ")} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Calibration history</CardTitle>
            {canManage && <CalibrationDialog assetId={asset.id} />}
          </CardHeader>
          <CardContent className="grid gap-2">
            {asset.calibrationRecords.length === 0 && <p className="text-sm text-muted-foreground">No calibration records.</p>}
            {asset.calibrationRecords.map((c) => (
              <div key={c.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                <div>
                  <span>{formatDate(c.calibrationDate)}</span>
                  {c.provider && <span className="text-muted-foreground"> — {c.provider}</span>}
                  {c.nextCalibrationDate && <span className="text-muted-foreground"> · next {formatDate(c.nextCalibrationDate)}</span>}
                </div>
                <Badge variant={RESULT_VARIANT[c.result]}>{c.result}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="sm:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Maintenance history</CardTitle>
            {canManage && <MaintenanceDialog assetId={asset.id} />}
          </CardHeader>
          <CardContent className="grid gap-2">
            {asset.maintenanceRecords.length === 0 && <p className="text-sm text-muted-foreground">No maintenance records.</p>}
            {asset.maintenanceRecords.map((m) => (
              <div key={m.id} className="rounded-md border border-border p-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="capitalize">{m.maintenanceType}</span>
                  <span className="text-muted-foreground">{formatDate(m.serviceDate)}</span>
                </div>
                <p className="mt-1 text-muted-foreground">{m.workPerformed}</p>
                {m.serviceProvider && <p className="text-xs text-muted-foreground">Provider: {m.serviceProvider}</p>}
                {m.cost && <p className="text-xs text-muted-foreground">Cost: {Number(m.cost).toFixed(2)}</p>}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right capitalize">{value || "—"}</span>
    </div>
  )
}
