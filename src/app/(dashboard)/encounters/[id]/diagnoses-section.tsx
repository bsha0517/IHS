"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Plus, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { StatusBadge } from "@/components/ui/status-badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { EmptyState } from "@/components/ui/empty-state"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { addDiagnosisAction, updateDiagnosisStatusAction, searchDiagnosisCodesAction, type ActionState } from "@/app/(dashboard)/encounters/actions"
import type { Diagnosis, DiagnosisCode } from "@/generated/prisma/client"

const initialState: ActionState = {}

type DiagnosisWithCode = Diagnosis & { code: DiagnosisCode | null }

export function DiagnosesSection({
  encounterId,
  diagnoses,
  canEdit,
}: {
  encounterId: string
  diagnoses: DiagnosisWithCode[]
  canEdit: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  // Targeted backlog closure, item 5 (BACKLOG.md's "Void-returning
  // encounter-section actions... still swallow errors into the generic
  // error boundary") — same local try/catch + inline Alert pattern P3.3
  // already established for EncounterHeader's own status actions.
  const [actionError, setActionError] = useState<string | null>(null)

  function run(fn: () => Promise<ActionState>) {
    setActionError(null)
    startTransition(async () => {
      try {
        const result = await fn()
        if (result?.error) setActionError(result.error)
        else router.refresh()
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "That action couldn't be completed.")
      }
    })
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Diagnoses</CardTitle>
        {canEdit && <AddDiagnosisDialog encounterId={encounterId} />}
      </CardHeader>
      <CardContent className="grid gap-2">
        {actionError && (
          <Alert variant="destructive">
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        )}
        {diagnoses.length === 0 && <EmptyState title="No diagnoses recorded" />}
        {diagnoses.map((d) => (
          <div key={d.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
            <div>
              <p className="font-medium">
                {d.description} {d.isPrimary && <Badge className="ml-1">Primary</Badge>}
              </p>
              {d.code && <p className="font-mono text-xs text-muted-foreground">{d.code.code}</p>}
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge status={d.status} />
              {canEdit && d.status === "active" && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => run(() => updateDiagnosisStatusAction(encounterId, d.id, "resolved"))}
                >
                  Mark resolved
                </Button>
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function AddDiagnosisDialog({ encounterId }: { encounterId: string }) {
  const { open, setOpen, state, pending, submit } = useActionDialog(addDiagnosisAction, initialState)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<DiagnosisCode[]>([])
  const [selected, setSelected] = useState<DiagnosisCode | null>(null)
  const [description, setDescription] = useState("")
  const [searchOpen, setSearchOpen] = useState(false)
  const [searching, startSearch] = useTransition()
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!query.trim()) return
    const timeout = setTimeout(() => {
      startSearch(async () => {
        const found = await searchDiagnosisCodesAction(query)
        setResults(found)
        setSearchOpen(true)
      })
    }, 250)
    return () => clearTimeout(timeout)
  }, [query])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setSearchOpen(false)
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus /> Add diagnosis
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add diagnosis</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="encounterId" value={encounterId} />
          <input type="hidden" name="diagnosisCode" value={selected?.code ?? ""} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div ref={containerRef} className="relative grid gap-2">
            <Label htmlFor="code-search">ICD code (optional)</Label>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input
                id="code-search"
                value={selected ? `${selected.code} — ${selected.description}` : query}
                onChange={(e) => {
                  setSelected(null)
                  setQuery(e.target.value)
                }}
                placeholder="Search ICD code or description"
                className="pl-8"
              />
            </div>
            {searchOpen && query.trim() && (
              <div className="absolute top-full z-50 mt-1 w-full rounded-md border border-border bg-popover shadow-md">
                {searching && <p className="p-2 text-sm text-muted-foreground">Searching...</p>}
                {!searching && results.length === 0 && <p className="p-2 text-sm text-muted-foreground">No matches.</p>}
                {!searching &&
                  results.map((code) => (
                    <button
                      key={code.code}
                      type="button"
                      className="block w-full px-3 py-2 text-left text-sm hover:bg-muted"
                      onClick={() => {
                        setSelected(code)
                        setDescription(code.description)
                        setSearchOpen(false)
                      }}
                    >
                      <span className="font-medium">{code.code}</span> — {code.description}
                    </button>
                  ))}
              </div>
            )}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="description">Description</Label>
            <Input
              id="description"
              name="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="isPrimary" /> Primary diagnosis
          </label>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Add diagnosis"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
