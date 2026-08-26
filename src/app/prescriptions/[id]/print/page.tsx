import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { getPrescription } from "@/lib/domains/clinical/prescriptions"
import { getOrganization } from "@/lib/domains/identity/org-structure"
import { calculateAge, formatDate } from "@/lib/utils/dates"
import { PrintButton } from "@/app/prescriptions/[id]/print/print-button"

// Deliberately outside the (dashboard) route group — no sidebar/topbar chrome,
// just the document itself, per spec.md §82 ("professional printable"
// prescriptions with configurable clinic branding).
export default async function PrescriptionPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession()
  if (!session) redirect("/login")

  const { id } = await params
  const [prescription, organization] = await Promise.all([getPrescription(session, id), getOrganization(session)])

  return (
    <div className="mx-auto max-w-2xl p-8 print:p-0">
      <div className="mb-4 flex justify-end print:hidden">
        <PrintButton />
      </div>

      <div className="border-b border-border pb-4">
        <h1 className="text-xl font-semibold">{organization.displayName}</h1>
        <p className="text-sm text-muted-foreground">Prescription {prescription.prescriptionNumber}</p>
      </div>

      <div className="grid grid-cols-2 gap-4 border-b border-border py-4 text-sm">
        <div>
          <p className="text-muted-foreground">Patient</p>
          <p className="font-medium">
            {prescription.patient.firstName} {prescription.patient.lastName} ({prescription.patient.mrn})
          </p>
          <p>
            {calculateAge(prescription.patient.dob)}y · {prescription.patient.gender}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground">Prescribed by</p>
          <p className="font-medium">
            Dr. {prescription.provider.firstName} {prescription.provider.lastName}
          </p>
          <p>{formatDate(prescription.issuedAt)}</p>
        </div>
      </div>

      <table className="mt-4 w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="py-2">Medication</th>
            <th className="py-2">Dose</th>
            <th className="py-2">Frequency</th>
            <th className="py-2">Route</th>
            <th className="py-2">Duration</th>
          </tr>
        </thead>
        <tbody>
          {prescription.items.map((item, i) => (
            <tr key={item.id} className="border-b border-border/50 align-top">
              <td className="py-2">
                <span className="font-medium">
                  {i + 1}. {item.medicationName}
                </span>
                {item.strength && <span className="text-muted-foreground"> {item.strength}</span>}
                {item.instructions && <p className="text-xs text-muted-foreground">{item.instructions}</p>}
              </td>
              <td className="py-2">{item.dose}</td>
              <td className="py-2">{item.frequency}</td>
              <td className="py-2">{item.route}</td>
              <td className="py-2">{item.durationDays ? `${item.durationDays} days` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-16 flex justify-end">
        <div className="text-center text-sm">
          <div className="mb-1 h-12 w-48 border-b border-border" />
          <p>
            Dr. {prescription.provider.firstName} {prescription.provider.lastName}
          </p>
        </div>
      </div>
    </div>
  )
}
