import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { formatDate, formatDateTime } from "@/lib/utils/dates"
import type { Patient, PatientAllergy, PatientCondition, PatientMedicationHistory, VitalSign, Encounter, Provider } from "@/generated/prisma/client"

type PatientWithProfile = Patient & {
  allergies: PatientAllergy[]
  conditions: PatientCondition[]
  medicationHistory: PatientMedicationHistory[]
}

/** The doctor's at-a-glance sidebar (spec.md §23): allergies, problems, current
 * medications, recent vitals, and previous encounters — all read-only context. */
export function PatientSummarySidebar({
  patient,
  previousEncounters,
  vitals,
}: {
  patient: PatientWithProfile
  previousEncounters: (Encounter & { provider: Provider })[]
  vitals: VitalSign[]
}) {
  const activeProblems = patient.conditions.filter((c) => c.status === "active")
  const currentMedications = patient.medicationHistory.filter((m) => m.status === "current")
  const latestVitals = vitals[0]

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Allergies</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1.5 text-sm">
          {patient.allergies.length === 0 && <p className="text-muted-foreground">None recorded.</p>}
          {patient.allergies.map((a) => (
            <div key={a.id} className="flex items-center justify-between">
              <span>{a.allergen}</span>
              <Badge variant={a.severity === "severe" ? "destructive" : "outline"} className="text-xs">
                {a.severity}
              </Badge>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Problems</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1.5 text-sm">
          {activeProblems.length === 0 && <p className="text-muted-foreground">None recorded.</p>}
          {activeProblems.map((c) => (
            <p key={c.id}>{c.description}</p>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Current Medications</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1.5 text-sm">
          {currentMedications.length === 0 && <p className="text-muted-foreground">None recorded.</p>}
          {currentMedications.map((m) => (
            <p key={m.id}>
              {m.medicationName} {m.dose && <span className="text-muted-foreground">— {m.dose}</span>}
            </p>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Recent Vitals</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1 text-sm">
          {!latestVitals && <p className="text-muted-foreground">None recorded this encounter.</p>}
          {latestVitals && (
            <>
              <p className="text-xs text-muted-foreground">{formatDateTime(latestVitals.recordedAt)}</p>
              {latestVitals.bloodPressureSystolic && (
                <p>
                  BP {latestVitals.bloodPressureSystolic}/{latestVitals.bloodPressureDiastolic}
                </p>
              )}
              {latestVitals.pulseBpm && <p>Pulse {latestVitals.pulseBpm} bpm</p>}
              {latestVitals.temperatureCelsius && <p>Temp {String(latestVitals.temperatureCelsius)}°C</p>}
              {latestVitals.bmi && <p>BMI {String(latestVitals.bmi)}</p>}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Previous Encounters</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          {previousEncounters.length === 0 && <p className="text-muted-foreground">None.</p>}
          {previousEncounters.map((e) => (
            <Link key={e.id} href={`/encounters/${e.id}`} className="block hover:underline">
              <p>{formatDate(e.startAt)}</p>
              <p className="text-xs text-muted-foreground">
                {e.encounterType.replace("_", " ")} · Dr. {e.provider.lastName}
              </p>
            </Link>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
