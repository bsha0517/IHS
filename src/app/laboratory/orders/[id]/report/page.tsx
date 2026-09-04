import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { getLabOrder } from "@/lib/domains/laboratory/orders"
import { getOrganizationIdentity } from "@/lib/domains/identity/org-structure"
import { writeClinicalAccessLog } from "@/lib/platform/access-log"
import { calculateAge, formatDate, formatDateTime } from "@/lib/utils/dates"
import { PrintButton } from "@/app/laboratory/orders/[id]/report/print-button"

const FLAG_LABEL: Record<string, string> = {
  low: "Low",
  high: "High",
  critical_low: "Critical Low",
  critical_high: "Critical High",
}

// P3.5 §18/§19/§25: the order detail page's own "View report" link
// (shown once `order.status === "completed"`) pointed at this exact path,
// but the page never existed — a genuine, pre-existing dead link found
// while tracing the doctor-result-return path this batch is centered on.
// Deliberately outside the (dashboard) route group — no sidebar/topbar
// chrome, just the document itself — matching the exact convention
// `prescriptions/[id]/print` already established. Read-only: this is a
// result *view*, not another entry point into the operational workflow
// (assign/enter/verify all still live only on the dashboard order page).
export default async function LabReportPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession()
  if (!session) redirect("/login")

  const { id } = await params
  // P3.6 §30: previously a static heading, to avoid `getOrganization`'s
  // `settings.view` requirement blocking this page for Doctor — now uses
  // the same minimal, permission-light read P3.6 built for prescription
  // printing (see `getOrganizationIdentity`'s own comment).
  const [order, organization] = await Promise.all([getLabOrder(session, id), getOrganizationIdentity(session)])
  const verifiedTests = order.labOrderTests.filter((t) => t.status === "verified")

  // A "result view" (SECURITY.md §5) — getLabOrder itself doesn't log
  // (it's also the operational lab-ops page lab staff open routinely), but
  // this specific destination exists only to show a patient's verified
  // result to whoever the encounter/queue link sent here, so it logs
  // metadata only, same as Patient 360's own Lab Results tab.
  await writeClinicalAccessLog({ session, patientId: order.patientId, resourceType: "lab_results", action: "view" })

  return (
    <div className="mx-auto max-w-2xl p-8 print:p-0">
      <div className="mb-4 flex justify-end print:hidden">
        <PrintButton />
      </div>

      <div className="border-b border-border pb-4">
        <h1 className="text-xl font-semibold">{organization.displayName}</h1>
        <p className="text-sm text-muted-foreground">Laboratory Report {order.orderNumber}</p>
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

      {verifiedTests.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No verified results are available for this order yet.</p>
      ) : (
        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="py-2">Test</th>
              <th className="py-2">Result</th>
              <th className="py-2">Reference Range</th>
              <th className="py-2">Flag</th>
              <th className="py-2">Verified</th>
            </tr>
          </thead>
          <tbody>
            {verifiedTests.map((t) => (
              <tr key={t.id} className="border-b border-border/50 align-top">
                <td className="py-2 font-medium">{t.labTest.name}</td>
                <td className="py-2">{t.numericValue != null ? `${t.numericValue} ${t.unit ?? ""}` : (t.textValue ?? "—")}</td>
                <td className="py-2">
                  {t.referenceRangeLow != null && t.referenceRangeHigh != null
                    ? `${t.referenceRangeLow}–${t.referenceRangeHigh}`
                    : (t.referenceRangeText ?? "—")}
                </td>
                <td className="py-2">{t.abnormalFlag && t.abnormalFlag !== "normal" ? (FLAG_LABEL[t.abnormalFlag] ?? t.abnormalFlag) : "—"}</td>
                <td className="py-2">{t.verifiedAt ? formatDateTime(t.verifiedAt) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
