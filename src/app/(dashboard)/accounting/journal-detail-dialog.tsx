"use client"

import { Eye } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

type JournalLine = {
  id: string
  account: { code: string; name: string }
  debit: number
  credit: number
  description: string | null
}

export function JournalDetailDialog({
  journalNumber,
  description,
  lines,
}: {
  journalNumber: string
  description: string
  lines: JournalLine[]
}) {
  const totalDebit = lines.reduce((sum, l) => sum + Number(l.debit), 0)
  const totalCredit = lines.reduce((sum, l) => sum + Number(l.credit), 0)

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label="View lines">
          <Eye className="size-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{journalNumber}</DialogTitle>
        </DialogHeader>
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
      </DialogContent>
    </Dialog>
  )
}
