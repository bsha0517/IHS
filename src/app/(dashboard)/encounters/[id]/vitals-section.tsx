"use client"

import { useActionState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { formatDateTime } from "@/lib/utils/dates"
import { recordVitalsAction, type ActionState } from "@/app/(dashboard)/encounters/actions"
import type { VitalSign } from "@/generated/prisma/client"

const initialState: ActionState = {}

type VitalFieldName =
  | "heightCm"
  | "weightKg"
  | "bloodPressureSystolic"
  | "bloodPressureDiastolic"
  | "pulseBpm"
  | "temperatureCelsius"
  | "oxygenSaturationPercent"
  | "respiratoryRatePerMin"
  | "bloodGlucoseMgDl"

const FIELDS: { name: VitalFieldName; label: string; step?: string }[] = [
  { name: "heightCm", label: "Height (cm)" },
  { name: "weightKg", label: "Weight (kg)", step: "0.1" },
  { name: "bloodPressureSystolic", label: "BP Systolic" },
  { name: "bloodPressureDiastolic", label: "BP Diastolic" },
  { name: "pulseBpm", label: "Pulse (bpm)" },
  { name: "temperatureCelsius", label: "Temp (°C)", step: "0.1" },
  { name: "oxygenSaturationPercent", label: "SpO2 (%)" },
  { name: "respiratoryRatePerMin", label: "Resp. rate" },
  { name: "bloodGlucoseMgDl", label: "Glucose (mg/dL)" },
]

export function VitalsSection({
  encounterId,
  vitals,
  canEdit,
}: {
  encounterId: string
  vitals: VitalSign[]
  canEdit: boolean
}) {
  const [state, formAction, pending] = useActionState(recordVitalsAction, initialState)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Vitals</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {vitals.length > 0 && (
          <div className="grid gap-2">
            {vitals.map((v) => (
              <div key={v.id} className="rounded-md border border-border p-2 text-sm">
                <p className="text-xs text-muted-foreground">{formatDateTime(v.recordedAt)}</p>
                <p>
                  {v.heightCm && `Ht ${v.heightCm}cm `}
                  {v.weightKg && `Wt ${v.weightKg}kg `}
                  {v.bmi && `BMI ${v.bmi} `}
                  {v.bloodPressureSystolic && `BP ${v.bloodPressureSystolic}/${v.bloodPressureDiastolic} `}
                  {v.pulseBpm && `Pulse ${v.pulseBpm} `}
                  {v.temperatureCelsius && `Temp ${v.temperatureCelsius}°C `}
                  {v.oxygenSaturationPercent && `SpO2 ${v.oxygenSaturationPercent}% `}
                  {v.respiratoryRatePerMin && `RR ${v.respiratoryRatePerMin} `}
                  {v.bloodGlucoseMgDl && `Glucose ${v.bloodGlucoseMgDl}mg/dL`}
                </p>
              </div>
            ))}
          </div>
        )}

        {canEdit && (
          <form action={formAction} className="grid gap-4">
            <input type="hidden" name="encounterId" value={encounterId} />
            {state.error && (
              <Alert variant="destructive">
                <AlertDescription>{state.error}</AlertDescription>
              </Alert>
            )}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {FIELDS.map((field) => (
                <div key={field.name} className="grid gap-1.5">
                  <Label htmlFor={field.name} className="text-xs">
                    {field.label}
                  </Label>
                  <Input id={field.name} name={field.name} type="number" step={field.step} />
                </div>
              ))}
            </div>
            <div>
              <Button type="submit" size="sm" disabled={pending}>
                {pending ? "Saving..." : "Record vitals"}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  )
}
