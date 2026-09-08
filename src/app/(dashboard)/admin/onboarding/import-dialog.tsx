"use client"

import { useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Upload, Download, CheckCircle2, AlertTriangle, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { dryRunImportAction, commitImportAction, type DryRunActionState, type CommitActionState } from "@/app/(dashboard)/admin/onboarding/actions"
import type { ImportType } from "@/lib/domains/onboarding/imports/registry"

/**
 * P4.6 §37/§38 — a single reusable dialog for every import type (§10's own
 * "one architecture, not a bespoke UI per entity"). Deliberately does NOT
 * use the shared `useActionDialog` hook: that hook auto-closes on the
 * first successful action, which fits a single-step create form but not
 * this multi-step "upload → dry run → review → explicit commit → result"
 * flow, where the dialog must stay open across two separate server-action
 * calls that share the same selected file.
 */
export function ImportDialog({
  type,
  label,
  helpText,
  templateUrl,
  confirmationText,
}: {
  type: ImportType
  label: string
  helpText: string[]
  templateUrl: string
  /** P4.9.2 §25/§55 — set only for high-risk importers; Commit stays disabled until this exact statement is acknowledged. */
  confirmationText?: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [dryRun, setDryRun] = useState<DryRunActionState | null>(null)
  const [commitResult, setCommitResult] = useState<CommitActionState | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // The <input type="file"> unmounts once the dry-run summary renders (its
  // wrapping <form> is conditionally removed below), which resets
  // fileInputRef.current to null — so the file itself must be captured into
  // state up front rather than re-read from the ref at commit time.
  const [selectedFile, setSelectedFile] = useState<File | null>(null)

  function reset() {
    setDryRun(null)
    setCommitResult(null)
    setSelectedFile(null)
    setConfirmed(false)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) reset()
  }

  function handleDryRun(formData: FormData) {
    formData.set("type", type)
    const file = formData.get("file")
    setSelectedFile(file instanceof File ? file : null)
    startTransition(async () => {
      setCommitResult(null)
      const result = await dryRunImportAction(formData)
      setDryRun(result)
    })
  }

  function handleCommit() {
    if (!selectedFile || !dryRun?.jobId) return
    const formData = new FormData()
    formData.set("type", type)
    formData.set("jobId", dryRun.jobId)
    formData.set("file", selectedFile)
    startTransition(async () => {
      const result = await commitImportAction(formData)
      setCommitResult(result)
      if (result.result?.status === "completed") router.refresh()
    })
  }

  const summary = dryRun?.summary

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Upload className="size-3.5" /> Import
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import {label}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="flex items-center justify-between rounded-md border border-border bg-muted/40 p-3 text-sm">
            <div className="grid gap-1">
              <p className="font-medium">Step 1 — download the template</p>
              <ul className="list-disc pl-4 text-xs text-muted-foreground">
                {helpText.map((h, i) => (
                  <li key={i}>{h}</li>
                ))}
              </ul>
            </div>
            <Button size="sm" variant="outline" asChild>
              <a href={templateUrl} download>
                <Download className="size-3.5" /> Template
              </a>
            </Button>
          </div>

          {!dryRun && (
            <form action={handleDryRun} className="grid gap-3">
              <p className="text-sm font-medium">Step 2 — upload your completed CSV and validate</p>
              <input ref={fileInputRef} type="file" name="file" accept=".csv,text/csv" required className="text-sm" />
              <Button type="submit" disabled={pending} className="w-fit">
                {pending ? "Validating..." : "Validate (dry run)"}
              </Button>
            </form>
          )}

          {dryRun?.error && (
            <Alert variant="destructive">
              <XCircle className="size-4" />
              <AlertDescription>{dryRun.error}</AlertDescription>
            </Alert>
          )}

          {summary && (
            <div className="grid gap-3">
              <p className="text-sm font-medium">Step 3 — review before committing</p>
              <div className="grid grid-cols-4 gap-2 text-center text-sm">
                <div className="rounded-md border border-border p-2">
                  <p className="text-lg font-semibold">{summary.totalRows}</p>
                  <p className="text-xs text-muted-foreground">Total rows</p>
                </div>
                <div className="rounded-md border border-border p-2">
                  <p className="text-lg font-semibold text-green-600">{summary.validRows}</p>
                  <p className="text-xs text-muted-foreground">Valid</p>
                </div>
                <div className="rounded-md border border-border p-2">
                  <p className="text-lg font-semibold text-amber-600">{summary.duplicateRows}</p>
                  <p className="text-xs text-muted-foreground">Duplicate</p>
                </div>
                <div className="rounded-md border border-border p-2">
                  <p className="text-lg font-semibold text-destructive">{summary.invalidRows}</p>
                  <p className="text-xs text-muted-foreground">Invalid</p>
                </div>
              </div>

              {summary.domainSummary && summary.domainSummary.length > 0 && (
                <div className="grid grid-cols-2 gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm sm:grid-cols-3">
                  {summary.domainSummary.map((d) => (
                    <div key={d.label}>
                      <p className="font-semibold">{d.value}</p>
                      <p className="text-xs text-muted-foreground">{d.label}</p>
                    </div>
                  ))}
                </div>
              )}

              {summary.invalidRows > 0 && dryRun.jobId && (
                <a href={`/api/onboarding/errors/${dryRun.jobId}`} download className="text-sm text-primary hover:underline">
                  Download full error report (CSV)
                </a>
              )}

              <div className="max-h-64 overflow-y-auto rounded-md border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Row</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Detail</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summary.preview.map((r) => (
                      <TableRow key={r.rowNumber}>
                        <TableCell>{r.rowNumber}</TableCell>
                        <TableCell>
                          <Badge variant={r.status === "valid" ? "default" : r.status === "duplicate" ? "secondary" : "destructive"}>{r.status}</Badge>
                        </TableCell>
                        <TableCell className="text-xs">
                          {r.status === "invalid" ? r.issues.map((i) => i.message).join("; ") : r.summary}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {summary.totalRows > summary.preview.length && (
                  <p className="p-2 text-center text-xs text-muted-foreground">Showing first {summary.preview.length} of {summary.totalRows} rows.</p>
                )}
              </div>

              {!commitResult && (
                <div className="grid gap-3">
                  {confirmationText && (
                    <label className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                      <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                      <span>{confirmationText}</span>
                    </label>
                  )}
                  <div className="flex items-center justify-between">
                    <Button variant="outline" size="sm" onClick={reset} disabled={pending}>
                      Start over
                    </Button>
                    <Button size="sm" onClick={handleCommit} disabled={pending || summary.validRows === 0 || (Boolean(confirmationText) && !confirmed)}>
                      {pending ? "Importing..." : `Commit ${summary.validRows} row(s)`}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {commitResult?.error && (
            <Alert variant="destructive">
              <XCircle className="size-4" />
              <AlertDescription>{commitResult.error}</AlertDescription>
            </Alert>
          )}

          {commitResult?.result && (
            <Alert variant={commitResult.result.status === "completed" ? "default" : "destructive"}>
              {commitResult.result.status === "completed" ? <CheckCircle2 className="size-4" /> : <AlertTriangle className="size-4" />}
              <AlertDescription>
                {commitResult.result.status === "completed"
                  ? `Imported ${commitResult.result.importedRows} row(s), skipped ${commitResult.result.skippedRows} duplicate/invalid row(s).`
                  : `Import stopped at batch ${commitResult.result.failedAtBatch} of ${commitResult.result.totalBatches} — ${commitResult.result.importedRows} row(s) were committed before the failure. Re-run the same file: already-imported rows will be detected as duplicates and skipped automatically.`}
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
