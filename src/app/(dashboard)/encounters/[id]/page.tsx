import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { getEncounter, listPatientEncounters } from "@/lib/domains/clinical/encounters"
import { listProviders } from "@/lib/domains/providers/service"
import { serializeDecimals } from "@/lib/utils/serialize"
import { EncounterHeader } from "@/app/(dashboard)/encounters/[id]/encounter-header"
import { PatientSummarySidebar } from "@/app/(dashboard)/encounters/[id]/patient-summary-sidebar"
import { NoteForm } from "@/app/(dashboard)/encounters/[id]/note-form"
import { VitalsSection } from "@/app/(dashboard)/encounters/[id]/vitals-section"
import { DiagnosesSection } from "@/app/(dashboard)/encounters/[id]/diagnoses-section"
import { OrdersSection } from "@/app/(dashboard)/encounters/[id]/orders-section"
import { PrescriptionsSection } from "@/app/(dashboard)/encounters/[id]/prescriptions-section"
import { FollowUpSection } from "@/app/(dashboard)/encounters/[id]/follow-up-section"

export default async function EncounterWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession()
  if (!session || !can(session, "encounter.view")) redirect("/dashboard")

  const { id } = await params
  // Every value below crosses into "use client" sections further down this
  // page (EncounterHeader, VitalsSection, PatientSummarySidebar) — Prisma's
  // Decimal instances (Provider.consultationFee, VitalSign.heightCm/weightKg/
  // bmi/temperatureCelsius/bloodGlucoseMgDl) can't survive that boundary, so
  // serialize once here rather than re-deriving Decimal-free field picks at
  // every call site (see src/lib/utils/serialize.ts).
  const encounter = serializeDecimals(await getEncounter(session, id))

  const [previousEncountersRaw, providers] = await Promise.all([
    listPatientEncounters(session, encounter.patientId),
    listProviders(session),
  ])
  const previousEncounters = serializeDecimals(
    previousEncountersRaw.filter((e) => e.id !== encounter.id).slice(0, 5)
  )

  const canEdit = can(session, "clinical_notes.edit") && encounter.status !== "finalized"
  const canFinalize = can(session, "encounter.finalize")
  const providerOptions = providers.map((p) => ({ id: p.id, firstName: p.firstName, lastName: p.lastName }))

  const consultationNote = encounter.notes.find((n) => n.noteType === "consultation") ?? null

  return (
    <div className="flex flex-col gap-6">
      <EncounterHeader encounter={encounter} canFinalize={canFinalize} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[280px_1fr]">
        <PatientSummarySidebar patient={encounter.patient} previousEncounters={previousEncounters} vitals={encounter.vitalSigns} />

        <div className="flex flex-col gap-6">
          <VitalsSection encounterId={encounter.id} vitals={encounter.vitalSigns} canEdit={canEdit} />
          <NoteForm encounterId={encounter.id} note={consultationNote} canEdit={canEdit} />
          <DiagnosesSection encounterId={encounter.id} diagnoses={encounter.diagnoses} canEdit={canEdit} />
          <OrdersSection encounterId={encounter.id} orders={encounter.orders} providers={providerOptions} canEdit={canEdit} />
          <PrescriptionsSection encounterId={encounter.id} prescriptions={encounter.prescriptions} canEdit={canEdit} />
          <FollowUpSection encounterId={encounter.id} followUps={encounter.followUps} canEdit={canEdit} />
        </div>
      </div>
    </div>
  )
}
