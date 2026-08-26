"use client"

import { useActionState, useState } from "react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { saveNoteAction, createAmendmentAction, type ActionState } from "@/app/(dashboard)/encounters/actions"
import type { ClinicalNote } from "@/generated/prisma/client"

const initialState: ActionState = {}

const FIELDS: { name: keyof Pick<ClinicalNote, "chiefComplaint" | "historyOfPresentIllness" | "reviewOfSystems" | "examinationFindings" | "assessment" | "treatmentPlan">; label: string }[] = [
  { name: "chiefComplaint", label: "Chief Complaint" },
  { name: "historyOfPresentIllness", label: "History of Present Illness" },
  { name: "reviewOfSystems", label: "Review of Systems" },
  { name: "examinationFindings", label: "Examination Findings" },
  { name: "assessment", label: "Assessment" },
  { name: "treatmentPlan", label: "Treatment Plan" },
]

export function NoteForm({
  encounterId,
  note,
  canEdit,
}: {
  encounterId: string
  note: ClinicalNote | null
  canEdit: boolean
}) {
  const [state, formAction, pending] = useActionState(saveNoteAction, initialState)

  const isLocked = note?.status === "finalized"

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Consultation Note</CardTitle>
        {isLocked && <AmendmentDialog encounterId={encounterId} note={note} />}
      </CardHeader>
      <CardContent>
        {isLocked ? (
          <div className="grid gap-3 text-sm">
            {FIELDS.map((field) => (
              <div key={field.name}>
                <p className="text-xs font-medium text-muted-foreground">{field.label}</p>
                <p className="whitespace-pre-wrap">{note[field.name] || "—"}</p>
              </div>
            ))}
          </div>
        ) : canEdit ? (
          <form action={formAction} className="grid gap-4">
            <input type="hidden" name="encounterId" value={encounterId} />
            <input type="hidden" name="noteType" value="consultation" />
            {state.error && (
              <Alert variant="destructive">
                <AlertDescription>{state.error}</AlertDescription>
              </Alert>
            )}
            {FIELDS.map((field) => (
              <div key={field.name} className="grid gap-2">
                <Label htmlFor={field.name}>{field.label}</Label>
                <Textarea id={field.name} name={field.name} defaultValue={note?.[field.name] ?? ""} rows={3} />
              </div>
            ))}
            <div>
              <Button type="submit" size="sm" disabled={pending}>
                {pending ? "Saving..." : "Save note"}
              </Button>
            </div>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">No note recorded.</p>
        )}
      </CardContent>
    </Card>
  )
}

function AmendmentDialog({ encounterId, note }: { encounterId: string; note: ClinicalNote }) {
  const [open, setOpen] = useState(false)
  const [state, formAction, pending] = useActionState(createAmendmentAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Amend
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Amend finalized note</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="grid gap-4">
          <input type="hidden" name="encounterId" value={encounterId} />
          <input type="hidden" name="noteId" value={note.id} />
          <input type="hidden" name="noteType" value="consultation" />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <p className="text-xs text-muted-foreground">
            This creates a new version — the original finalized note is preserved as history, never overwritten.
          </p>
          {FIELDS.map((field) => (
            <div key={field.name} className="grid gap-2">
              <Label htmlFor={`amend-${field.name}`}>{field.label}</Label>
              <Textarea id={`amend-${field.name}`} name={field.name} defaultValue={note[field.name] ?? ""} rows={3} />
            </div>
          ))}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Save amendment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
