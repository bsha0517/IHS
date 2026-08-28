"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Undo2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { reverseJournalAction } from "@/app/(dashboard)/accounting/actions"

// P1 §24: "Journal: Use REVERSAL. Never physical delete once posted." — only
// ever shown for a manual journal (see page.tsx's gate); domain-tied
// journals reverse through their own domain's workflow instead.
export function ReverseJournalDialog({ journalId, journalNumber }: { journalId: string; journalNumber: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) {
          setReason("")
          setError(null)
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label="Reverse journal">
          <Undo2 className="size-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reverse {journalNumber}</DialogTitle>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <p className="text-sm text-muted-foreground">Posts a new journal with every line&apos;s debit/credit swapped. The original is never edited or deleted.</p>
        <Input placeholder="Reason for reversal" value={reason} onChange={(e) => setReason(e.target.value)} />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Back
          </Button>
          <Button
            variant="destructive"
            disabled={pending || !reason.trim()}
            onClick={() => {
              startTransition(async () => {
                const result = await reverseJournalAction(journalId, reason)
                if (result?.error) {
                  setError(result.error)
                  return
                }
                setOpen(false)
                router.refresh()
              })
            }}
          >
            {pending ? "Reversing..." : "Reverse journal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
