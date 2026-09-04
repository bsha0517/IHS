"use client"

import { useActionState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { FormSection } from "@/components/ui/form-section"
import { EmptyState } from "@/components/ui/empty-state"
import { formatDateTime } from "@/lib/utils/dates"
import { recordVitalsAction, type ActionState } from "@/app/(dashboard)/encounters/actions"
import type { VitalSign, User } from "@/generated/prisma/client"

const initialState: ActionState = {}

type VitalSignWithRecorder = VitalSign & { recordedByUser: Pick<User, "firstName" | "lastName"> | null }

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

/** P4.7A.1 §17 — one compact scannable "chip" per recorded vital, not a full-size MetricCard per field (that would turn nine vitals into an enormous dashboard). Only fields actually recorded on this set are shown. */
function VitalChip({ label, value, unit }: { label: string; value: string | number; unit?: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 px-2.5 py-1.5">
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold tabular-nums text-foreground">
        {value}
        {unit && <span className="ml-0.5 text-xs font-normal text-muted-foreground">{unit}</span>}
      </p>
    </div>
  )
}

function VitalSetChips({ v }: { v: VitalSignWithRecorder }) {
  const chips: { label: string; value: string | number; unit?: string }[] = []
  if (v.bloodPressureSystolic && v.bloodPressureDiastolic)
    chips.push({ label: "BP", value: `${v.bloodPressureSystolic}/${v.bloodPressureDiastolic}`, unit: "mmHg" })
  if (v.pulseBpm) chips.push({ label: "Pulse", value: v.pulseBpm, unit: "bpm" })
  if (v.temperatureCelsius) chips.push({ label: "Temp", value: String(v.temperatureCelsius), unit: "°C" })
  if (v.oxygenSaturationPercent) chips.push({ label: "SpO2", value: String(v.oxygenSaturationPercent), unit: "%" })
  if (v.respiratoryRatePerMin) chips.push({ label: "Resp. rate", value: v.respiratoryRatePerMin, unit: "/min" })
  if (v.weightKg) chips.push({ label: "Weight", value: String(v.weightKg), unit: "kg" })
  if (v.heightCm) chips.push({ label: "Height", value: String(v.heightCm), unit: "cm" })
  if (v.bmi) chips.push({ label: "BMI", value: String(v.bmi) })
  if (v.bloodGlucoseMgDl) chips.push({ label: "Glucose", value: String(v.bloodGlucoseMgDl), unit: "mg/dL" })

  if (chips.length === 0) return <p className="text-sm text-muted-foreground">No values recorded in this set.</p>

  return (
    <div className="flex flex-wrap gap-2">
      {chips.map((c) => (
        <VitalChip key={c.label} {...c} />
      ))}
    </div>
  )
}

export function VitalsSection({
  encounterId,
  vitals,
  canEdit,
}: {
  encounterId: string
  vitals: VitalSignWithRecorder[]
  canEdit: boolean
}) {
  const [state, formAction, pending] = useActionState(recordVitalsAction, initialState)
  const [latest, ...history] = vitals

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Vitals</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {/* P3.4 §13/§14: every recording is its own row (append-only —
            recordVitals always creates a new VitalSign, never updates one
            in place), so a second set taken later in the same encounter
            shows here as a second, separately-timestamped entry rather
            than overwriting the first. P3.4 §31: honest empty state
            instead of silently rendering nothing. */}
        {!latest ? (
          <EmptyState title="No vitals recorded" description="No vitals have been recorded for this encounter yet." />
        ) : (
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <p className="text-xs text-muted-foreground">
                Latest · {formatDateTime(latest.recordedAt)}
                {latest.recordedByUser && ` · recorded by ${latest.recordedByUser.firstName} ${latest.recordedByUser.lastName}`}
              </p>
              <VitalSetChips v={latest} />
            </div>

            {history.length > 0 && (
              <div className="grid gap-2 border-t border-border pt-3">
                <p className="text-xs font-medium text-muted-foreground">Earlier this encounter</p>
                {history.map((v) => (
                  <div key={v.id} className="grid gap-1.5 rounded-md border border-border p-2">
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(v.recordedAt)}
                      {v.recordedByUser && ` · ${v.recordedByUser.firstName} ${v.recordedByUser.lastName}`}
                    </p>
                    <VitalSetChips v={v} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {canEdit && (
          <form action={formAction}>
            <input type="hidden" name="encounterId" value={encounterId} />
            {state.error && (
              <Alert variant="destructive" className="mb-4">
                <AlertDescription>{state.error}</AlertDescription>
              </Alert>
            )}
            <FormSection title="Record new vitals" grid={false}>
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
            </FormSection>
          </form>
        )}
      </CardContent>
    </Card>
  )
}
