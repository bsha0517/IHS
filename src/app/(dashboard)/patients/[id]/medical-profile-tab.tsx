"use client"

import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { formatDate } from "@/lib/utils/dates"
import {
  addAllergyAction,
  addConditionAction,
  addMedicationHistoryAction,
  type ActionState,
} from "@/app/(dashboard)/patients/actions"
import type { Patient, PatientAllergy, PatientCondition, PatientMedicationHistory } from "@/generated/prisma/client"

const initialState: ActionState = {}

const CATEGORY_LABELS: Record<string, string> = {
  chronic: "Chronic disease",
  active: "Active condition",
  previous: "Previous condition",
  surgical_history: "Surgical history",
  family_history: "Family history",
  medical_history: "Medical history",
}

export function MedicalProfileTab({
  patient,
  canEdit,
}: {
  patient: Patient & { allergies: PatientAllergy[]; conditions: PatientCondition[]; medicationHistory: PatientMedicationHistory[] }
  canEdit: boolean
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Allergies</CardTitle>
          {canEdit && <AddAllergyDialog patientId={patient.id} />}
        </CardHeader>
        <CardContent className="grid gap-2">
          {patient.allergies.length === 0 && <p className="text-sm text-muted-foreground">None recorded.</p>}
          {patient.allergies.map((a) => (
            <div key={a.id} className="flex items-start justify-between gap-2 rounded-md border border-border p-2 text-sm">
              <div>
                <p className="font-medium">
                  {a.allergen} {a.isAlert && <Badge variant="destructive">Alert</Badge>}
                </p>
                {a.reaction && <p className="text-muted-foreground">{a.reaction}</p>}
              </div>
              <Badge variant="outline">{a.severity}</Badge>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Conditions &amp; History</CardTitle>
          {canEdit && <AddConditionDialog patientId={patient.id} />}
        </CardHeader>
        <CardContent className="grid gap-2">
          {patient.conditions.length === 0 && <p className="text-sm text-muted-foreground">None recorded.</p>}
          {patient.conditions.map((c) => (
            <div key={c.id} className="flex items-start justify-between gap-2 rounded-md border border-border p-2 text-sm">
              <div>
                <p className="font-medium">
                  {c.description} {c.isAlert && <Badge variant="destructive">Alert</Badge>}
                </p>
                <p className="text-muted-foreground">{formatDate(c.notedAt)}</p>
              </div>
              <Badge variant="outline">{CATEGORY_LABELS[c.category] ?? c.category}</Badge>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="sm:col-span-2">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Medication History</CardTitle>
          {canEdit && <AddMedicationDialog patientId={patient.id} />}
        </CardHeader>
        <CardContent className="grid gap-2">
          {patient.medicationHistory.length === 0 && <p className="text-sm text-muted-foreground">None recorded.</p>}
          {patient.medicationHistory.map((m) => (
            <div key={m.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
              <span className="font-medium">
                {m.medicationName} {m.dose && <span className="font-normal text-muted-foreground">— {m.dose}</span>}
              </span>
              <Badge variant={m.status === "current" ? "default" : "secondary"}>{m.status}</Badge>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

function AddAllergyDialog({ patientId }: { patientId: string }) {
  const { open, setOpen, state, pending, submit } = useActionDialog(addAllergyAction, initialState)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus /> Add
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add allergy</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="patientId" value={patientId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="allergen">Allergen</Label>
            <Input id="allergen" name="allergen" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="reaction">Reaction</Label>
            <Input id="reaction" name="reaction" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="severity">Severity</Label>
            <Select name="severity" required defaultValue="mild">
              <SelectTrigger id="severity" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mild">Mild</SelectItem>
                <SelectItem value="moderate">Moderate</SelectItem>
                <SelectItem value="severe">Severe</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="isAlert" /> Show as a critical alert on the patient header
          </label>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Add allergy"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function AddConditionDialog({ patientId }: { patientId: string }) {
  const { open, setOpen, state, pending, submit } = useActionDialog(addConditionAction, initialState)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus /> Add
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add condition / history</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="patientId" value={patientId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="category">Category</Label>
            <Select name="category" required defaultValue="active">
              <SelectTrigger id="category" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="description">Description</Label>
            <Input id="description" name="description" required />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="isAlert" /> Show as a critical alert on the patient header
          </label>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function AddMedicationDialog({ patientId }: { patientId: string }) {
  const { open, setOpen, state, pending, submit } = useActionDialog(addMedicationHistoryAction, initialState)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus /> Add
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add medication history</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="patientId" value={patientId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="medicationName">Medication</Label>
            <Input id="medicationName" name="medicationName" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="dose">Dose</Label>
            <Input id="dose" name="dose" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="status">Status</Label>
            <Select name="status" required defaultValue="current">
              <SelectTrigger id="status" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="current">Current</SelectItem>
                <SelectItem value="past">Past</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
