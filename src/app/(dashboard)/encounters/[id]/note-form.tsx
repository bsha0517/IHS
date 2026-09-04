"use client"

import { useActionState, useState } from "react"
import { Lock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { StatusBadge } from "@/components/ui/status-badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { formatDateTime } from "@/lib/utils/dates"
import { saveNoteAction, createAmendmentAction, type ActionState } from "@/app/(dashboard)/encounters/actions"
import type { ClinicalNote, User } from "@/generated/prisma/client"

const initialState: ActionState = {}

const FIELDS: { name: keyof Pick<ClinicalNote, "chiefComplaint" | "historyOfPresentIllness" | "reviewOfSystems" | "examinationFindings" | "assessment" | "treatmentPlan">; label: string }[] = [
  { name: "chiefComplaint", label: "Chief Complaint" },
  { name: "historyOfPresentIllness", label: "History of Present Illness" },
  { name: "reviewOfSystems", label: "Review of Systems" },
  { name: "examinationFindings", label: "Examination Findings" },
  { name: "assessment", label: "Assessment" },
  { name: "treatmentPlan", label: "Treatment Plan" },
]

type AuthorName = Pick<User, "firstName" | "lastName"> | null
type NoteVersion = ClinicalNote & { authoredByUser: AuthorName; finalizedByUser: AuthorName }

export function NoteForm({
  encounterId,
  note,
  history,
  canEdit,
}: {
  encounterId: string
  note: ClinicalNote | null
  /** P3.3 §25/§26: full version chain (oldest first) — length 1 when never amended. */
  history: NoteVersion[]
  canEdit: boolean
}) {
  const [state, formAction, pending] = useActionState(saveNoteAction, initialState)

  const isLocked = note?.status === "finalized"
  const hasAmendments = history.length > 1

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">Consultation Note</CardTitle>
          {note && <StatusBadge status={note.status} />}
          {hasAmendments && <Badge variant="outline">Amended</Badge>}
        </div>
        <div className="flex items-center gap-2">
          {hasAmendments && <HistoryDialog history={history} />}
          {isLocked && <AmendmentDialog encounterId={encounterId} note={note} />}
        </div>
      </CardHeader>
      <CardContent>
        {/* P4.7A.1 §10 — a finalized note must visually read as locked, not
            merely have disabled-looking fields with no explanation: a tinted
            read-only panel with an explicit "why" line, never a plain gray
            form. */}
        {isLocked ? (
          <div className="grid gap-3 rounded-md border border-border bg-muted/30 p-3">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="size-3.5" /> This note is finalized and read-only. Use Amend to add a correction — the original is preserved.
            </p>
            <div className="grid gap-3 text-sm">
              {FIELDS.map((field) => (
                <div key={field.name}>
                  <p className="text-xs font-medium text-muted-foreground">{field.label}</p>
                  <p className="whitespace-pre-wrap">{note[field.name] || "—"}</p>
                </div>
              ))}
            </div>
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

/**
 * P3.3 §25/§26: the doctor previously had no way to see a finalized note's
 * amendment history from the encounter workspace at all — `getNoteHistory`
 * already existed and was already access-logged, just never wired into this
 * UI. Uses the existing version-chain records directly; no new table.
 */
function HistoryDialog({ history }: { history: NoteVersion[] }) {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost">
          History ({history.length})
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Note history</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          {history.map((version, i) => {
            const isOriginal = i === 0
            const author = version.finalizedByUser ?? version.authoredByUser
            const authorName = author ? `${author.firstName} ${author.lastName}` : "Unknown"
            return (
              <div key={version.id} className="grid gap-2 rounded-md border border-border p-3 text-sm">
                <div className="flex items-center justify-between">
                  <p className="font-medium">{isOriginal ? "Original" : `Amendment ${i}`}</p>
                  <StatusBadge status={version.isCurrent ? "current" : "superseded"} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {authorName} · {version.finalizedAt ? formatDateTime(version.finalizedAt) : formatDateTime(version.createdAt)}
                </p>
                <div className="grid gap-2">
                  {FIELDS.filter((f) => version[f.name]).map((field) => (
                    <div key={field.name}>
                      <p className="text-xs font-medium text-muted-foreground">{field.label}</p>
                      <p className="whitespace-pre-wrap">{version[field.name]}</p>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
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
