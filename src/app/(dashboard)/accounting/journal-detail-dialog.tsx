"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { Eye } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { getJournalTraceAction } from "@/app/(dashboard)/accounting/actions"

type JournalLine = {
  id: string
  account: { code: string; name: string }
  debit: number
  credit: number
  description: string | null
}

type SourceReference = { label: string; summary: string; href: string | null } | null
type RelatedJournal = { id: string; journalNumber: string; referenceType: string; referenceTypeLabel: string; journalDate: string; relationship: "reverses" | "reversed by" | "related" }

/**
 * P2 §6: Business Transaction → Journal → Journal Lines → Source Reference,
 * read-only. Journal lines, the actor, and the timestamp were already
 * fetched for the journals list this dialog opens from (cheap — no extra
 * query per row); the source reference and any related/reversal journals
 * are fetched lazily, once, when the dialog actually opens — see
 * getJournalTraceAction's own doc comment for why that's not done for
 * every row up front.
 */
export function JournalDetailDialog({
  journalId,
  journalNumber,
  description,
  referenceType,
  referenceTypeLabel,
  branchName,
  journalDate,
  createdAt,
  postedByName,
  lines,
}: {
  journalId: string
  journalNumber: string
  description: string
  referenceType: string
  /** P3.9 §12-13: the same REFERENCE_TYPE_LABELS friendly label the journals list badge already uses — passed in rather than recomputed here, since traceability.ts is server-only and this is a client component. Falls back to a de-snake-cased referenceType if omitted. */
  referenceTypeLabel?: string
  branchName: string
  journalDate: string
  createdAt: string
  postedByName: string | null
  lines: JournalLine[]
}) {
  const [open, setOpen] = useState(false)
  const [trace, setTrace] = useState<{ source: SourceReference; related: RelatedJournal[] } | null>(null)
  const [pending, startTransition] = useTransition()

  const totalDebit = lines.reduce((sum, l) => sum + Number(l.debit), 0)
  const totalCredit = lines.reduce((sum, l) => sum + Number(l.credit), 0)

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (next && !trace) {
      startTransition(async () => {
        const result = await getJournalTraceAction(journalId)
        setTrace(result as { source: SourceReference; related: RelatedJournal[] })
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label="View lines">
          <Eye className="size-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{journalNumber}</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>Branch: {branchName}</span>
          <span>Posted by: {postedByName ?? "System"}</span>
          <span>Transaction type: {referenceTypeLabel ?? fallbackLabel(referenceType)}</span>
          <span>Journal date: {journalDate}</span>
          <span>Recorded: {createdAt}</span>
        </div>
        <p className="text-sm text-muted-foreground">{description}</p>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Account</TableHead>
              <TableHead className="text-right">Debit</TableHead>
              <TableHead className="text-right">Credit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l) => (
              <TableRow key={l.id}>
                <TableCell>
                  {l.account.code} — {l.account.name}
                </TableCell>
                <TableCell className="text-right">{Number(l.debit) > 0 ? Number(l.debit).toFixed(2) : ""}</TableCell>
                <TableCell className="text-right">{Number(l.credit) > 0 ? Number(l.credit).toFixed(2) : ""}</TableCell>
              </TableRow>
            ))}
            <TableRow className="font-medium">
              <TableCell>Total</TableCell>
              <TableCell className="text-right">{totalDebit.toFixed(2)}</TableCell>
              <TableCell className="text-right">{totalCredit.toFixed(2)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>

        <div className="grid gap-2">
          <h4 className="text-xs font-medium text-muted-foreground">Source transaction</h4>
          {pending && !trace && <p className="text-xs text-muted-foreground">Loading…</p>}
          {trace?.source && (
            <div className="rounded-md border border-border p-2 text-sm">
              <Badge variant="outline" className="mb-1">
                {trace.source.label}
              </Badge>
              <p>{trace.source.summary}</p>
              {trace.source.href && (
                <Link href={trace.source.href} className="text-xs text-primary underline">
                  Open source record
                </Link>
              )}
            </div>
          )}
        </div>

        {trace && trace.related.length > 0 && (
          <div className="grid gap-2">
            <h4 className="text-xs font-medium text-muted-foreground">Related journals</h4>
            {trace.related.map((r) => (
              <div key={r.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                <span>
                  {r.journalNumber} <span className="text-muted-foreground">({r.referenceTypeLabel})</span>
                </span>
                <Badge variant="secondary">{r.relationship}</Badge>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function fallbackLabel(type: string): string {
  return type.replace(/_/g, " ")
}
