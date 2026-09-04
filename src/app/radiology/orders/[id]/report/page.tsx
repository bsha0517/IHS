import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { getRadiologyOrder } from "@/lib/domains/radiology/orders"
import { getOrganizationIdentity } from "@/lib/domains/identity/org-structure"
import { writeClinicalAccessLog } from "@/lib/platform/access-log"
import { calculateAge, formatDate, formatDateTime } from "@/lib/utils/dates"
import { PrintButton } from "@/app/radiology/orders/[id]/report/print-button"

// P3.5 §18/§19/§25: same dead-link fix as laboratory's own report page —
// see that page's comment for the full reasoning. Deliberately outside the
// (dashboard) route group, matching `prescriptions/[id]/print`'s
// established convention. Read-only result view; no operational actions.
export default async function RadiologyReportPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession()
  if (!session) redirect("/login")

  const { id } = await params
  // P3.6 §30: previously a static heading — see laboratory's own report
  // page comment for the full reasoning.
  const [order, organization] = await Promise.all([getRadiologyOrder(session, id), getOrganizationIdentity(session)])
  const io = order.imagingOrder
  // Targeted backlog closure, item 7: this printable/official report view
  // must show the CURRENT report, not a stale original — see
  // radiology/orders/[id]/page.tsx's identical derivation.
  const latestAmendment = io?.amendments[io.amendments.length - 1] ?? null
  const currentReportText = latestAmendment?.reportText ?? io?.reportText ?? null
  const currentImpression = latestAmendment?.impression ?? io?.impression ?? null

  await writeClinicalAccessLog({ session, patientId: order.patientId, resourceType: "imaging_results", action: "view" })

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
        <p className="mt-4 text-sm text-muted-foreground">No verified report is available for this order yet.</p>
      ) : (
        <div className="mt-4 grid gap-3 text-sm">
          <div>
            <p className="text-muted-foreground">Study</p>
            <p className="font-medium">{io.imagingService.name}</p>
          </div>
          {currentReportText && (
            <div>
              <p className="text-muted-foreground">Findings{io.amendments.length > 0 ? " (amended)" : ""}</p>
              <p className="whitespace-pre-wrap rounded-md border border-border p-2">{currentReportText}</p>
            </div>
          )}
          {currentImpression && (
            <div>
              <p className="text-muted-foreground">Impression</p>
              <p className="whitespace-pre-wrap">{currentImpression}</p>
            </div>
          )}
          <p className="text-xs text-muted-foreground">Verified {io.verifiedAt ? formatDateTime(io.verifiedAt) : "—"}</p>
          {io.amendments.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Last amended {formatDateTime(io.amendments[io.amendments.length - 1].amendedAt)} — see the radiology order record for the full amendment history.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
