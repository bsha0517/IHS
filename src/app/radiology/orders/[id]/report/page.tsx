import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { getRadiologyOrder } from "@/lib/domains/radiology/orders"
import { getOrganization } from "@/lib/domains/identity/org-structure"
import { calculateAge, formatDate, formatDateTime } from "@/lib/utils/dates"
import { PrintButton } from "@/app/prescriptions/[id]/print/print-button"

// Deliberately outside the (dashboard) route group — no sidebar/topbar
// chrome, same precedent as the Prescription/Invoice/Lab Report print views
// (spec.md §82/§30's "Radiology report"). Only shows a verified ("Final
// Result") study.
export default async function RadiologyReportPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession()
  if (!session) redirect("/login")

  const { id } = await params
  const [order, organization] = await Promise.all([getRadiologyOrder(session, id), getOrganization(session)])
  const io = order.imagingOrder

  return (
    <div className="mx-auto max-w-2xl p-8 print:p-0">
      <div className="mb-4 flex justify-end print:hidden">
        <PrintButton />
      </div>

      <div className="border-b border-border pb-4">
        <h1 className="text-xl font-semibold">{organization.displayName}</h1>
        <p className="text-sm text-muted-foreground">Radiology Report {order.orderNumber}</p>
      </div>

      <div className="grid grid-cols-2 gap-4 border-b border-border py-4 text-sm">
        <div>
          <p className="text-muted-foreground">Patient</p>
          <p className="font-medium">
            {order.patient.firstName} {order.patient.lastName} ({order.patient.mrn})
          </p>
          <p>
            {calculateAge(order.patient.dob)}y · {order.patient.gender}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground">Ordered by</p>
          <p className="font-medium">
            Dr. {order.orderingProvider.firstName} {order.orderingProvider.lastName}
          </p>
          <p>{formatDate(order.orderedAt)}</p>
        </div>
      </div>

      {!io || io.status !== "verified" ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No verified report yet.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 border-b border-border py-4 text-sm">
            <div>
              <p className="text-muted-foreground">Study</p>
              <p className="font-medium">{io.imagingService.name}</p>
              <p>Accession {io.accessionNumber}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Performed</p>
              <p>{io.performedAt ? formatDateTime(io.performedAt) : "—"}</p>
            </div>
          </div>

          <div className="mt-4 grid gap-3 text-sm">
            <div>
              <p className="text-muted-foreground">Findings</p>
              <p className="whitespace-pre-wrap">{io.reportText}</p>
            </div>
            {io.impression && (
              <div>
                <p className="text-muted-foreground">Impression</p>
                <p className="whitespace-pre-wrap font-medium">{io.impression}</p>
              </div>
            )}
          </div>

          <div className="mt-16 flex justify-end">
            <div className="text-center text-sm">
              <div className="mb-1 h-12 w-48 border-b border-border" />
              <p>Verified {formatDate(io.verifiedAt!)}</p>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
