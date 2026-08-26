import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { getLabOrder } from "@/lib/domains/laboratory/orders"
import { getOrganization } from "@/lib/domains/identity/org-structure"
import { calculateAge, formatDate, formatDateTime } from "@/lib/utils/dates"
import { PrintButton } from "@/app/prescriptions/[id]/print/print-button"

// Deliberately outside the (dashboard) route group — no sidebar/topbar
// chrome, same precedent as the Prescription/Invoice print views (spec.md
// §82/§28's "Result Reporting"). Only shows verified ("Final Result") lines.
export default async function LabReportPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession()
  if (!session) redirect("/login")

  const { id } = await params
  const [order, organization] = await Promise.all([getLabOrder(session, id), getOrganization(session)])
  const verifiedTests = order.labOrderTests.filter((t) => t.status === "verified")

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

      {order.specimens.map((s) => (
        <p key={s.id} className="pt-2 text-xs text-muted-foreground">
          Specimen {s.specimenNumber} ({s.specimenType}){s.collectedAt ? ` — collected ${formatDateTime(s.collectedAt)}` : ""}
        </p>
      ))}

      <table className="mt-4 w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="py-2">Test</th>
            <th className="py-2">Result</th>
            <th className="py-2">Unit</th>
            <th className="py-2">Reference Range</th>
            <th className="py-2">Flag</th>
          </tr>
        </thead>
        <tbody>
          {verifiedTests.length === 0 && (
            <tr>
              <td colSpan={5} className="py-4 text-center text-muted-foreground">
                No verified results yet.
              </td>
            </tr>
          )}
          {verifiedTests.map((t) => (
            <tr key={t.id} className="border-b border-border/50 align-top">
              <td className="py-2 font-medium">{t.labTest.name}</td>
              <td className={`py-2 ${t.abnormalFlag && t.abnormalFlag !== "normal" ? "font-semibold" : ""}`}>
                {t.numericValue != null ? String(t.numericValue) : t.textValue}
              </td>
              <td className="py-2">{t.unit ?? "—"}</td>
              <td className="py-2">{t.referenceRangeLow != null && t.referenceRangeHigh != null ? `${t.referenceRangeLow}–${t.referenceRangeHigh}` : t.referenceRangeText ?? "—"}</td>
              <td className="py-2 capitalize">{t.abnormalFlag && t.abnormalFlag !== "normal" ? t.abnormalFlag.replace("_", " ") : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-16 flex justify-end">
        <div className="text-center text-sm">
          <div className="mb-1 h-12 w-48 border-b border-border" />
          <p>Verified by</p>
        </div>
      </div>
    </div>
  )
}
