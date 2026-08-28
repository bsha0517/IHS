"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Lock, LockOpen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { formatDateTime } from "@/lib/utils/dates"
import { closePeriodAction, reopenPeriodAction } from "@/app/(dashboard)/accounting/actions"

type Period = {
  id: string
  periodStart: Date
  status: "open" | "closed"
  closedBy: string | null
  closedAt: Date
  reason: string
}

function monthLabel(date: Date) {
  return new Date(date).toLocaleDateString(undefined, { year: "numeric", month: "long", timeZone: "UTC" })
}

/**
 * P1 §31: a period with no row here is implicitly open — this panel lists
 * only periods that have ever been closed (present or past), plus a form to
 * close the current or a past month. There is no "override and post anyway"
 * control — reopening (audited) is the only way past a closed period, by
 * design (see periods.ts's own doc comment).
 */
export function PeriodsPanel({ periods }: { periods: Period[] }) {
  const router = useRouter()
  const [closeOpen, setCloseOpen] = useState(false)
  const [closeReason, setCloseReason] = useState("")
  const [closeError, setCloseError] = useState<string | null>(null)
  const [reopenTarget, setReopenTarget] = useState<Period | null>(null)
  const [reopenReason, setReopenReason] = useState("")
  const [reopenError, setReopenError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const now = new Date()
  const defaultYear = now.getUTCFullYear()
  const defaultMonth = now.getUTCMonth() + 1

  return (
    <Card>
      <CardContent className="grid gap-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            A month with no row below is open. Closing blocks every posting into it — including manual journals — for everyone; there is no override, only reopening.
          </p>
          <Dialog
            open={closeOpen}
            onOpenChange={(o) => {
              setCloseOpen(o)
              if (o) {
                setCloseReason("")
                setCloseError(null)
              }
            }}
          >
            <DialogTrigger asChild>
              <Button size="sm" variant="outline">
                <Lock /> Close a period
              </Button>
            </DialogTrigger>
            <DialogContent>
              <form
                className="grid gap-4"
                onSubmit={(e) => {
                  e.preventDefault()
                  const formData = new FormData(e.currentTarget)
                  const year = Number(formData.get("year"))
                  const month = Number(formData.get("month"))
                  startTransition(async () => {
                    const result = await closePeriodAction(year, month, closeReason)
                    if (result?.error) {
                      setCloseError(result.error)
                      return
                    }
                    setCloseOpen(false)
                    router.refresh()
                  })
                }}
              >
                <DialogHeader>
                  <DialogTitle>Close a period</DialogTitle>
                </DialogHeader>
                {closeError && (
                  <Alert variant="destructive">
                    <AlertDescription>{closeError}</AlertDescription>
                  </Alert>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1">
                    <label className="text-xs text-muted-foreground">Year</label>
                    <Input name="year" type="number" defaultValue={defaultYear} required />
                  </div>
                  <div className="grid gap-1">
                    <label className="text-xs text-muted-foreground">Month (1-12)</label>
                    <Input name="month" type="number" min={1} max={12} defaultValue={defaultMonth} required />
                  </div>
                </div>
                <Input placeholder="Reason for closing" value={closeReason} onChange={(e) => setCloseReason(e.target.value)} required />
                <DialogFooter>
                  <Button type="submit" variant="destructive" disabled={pending || !closeReason.trim()}>
                    {pending ? "Closing..." : "Close period"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Period</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last change</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {periods.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  No period has ever been closed — everything is open.
                </TableCell>
              </TableRow>
            )}
            {periods.map((p) => (
              <TableRow key={p.id}>
                <TableCell>{monthLabel(p.periodStart)}</TableCell>
                <TableCell>
                  <Badge variant={p.status === "closed" ? "destructive" : "outline"}>{p.status}</Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{formatDateTime(p.closedAt)}</TableCell>
                <TableCell className="text-sm">{p.reason}</TableCell>
                <TableCell>
                  {p.status === "closed" && (
                    <Button size="sm" variant="ghost" onClick={() => setReopenTarget(p)}>
                      <LockOpen className="size-3.5" /> Reopen
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog
        open={!!reopenTarget}
        onOpenChange={(o) => {
          if (!o) setReopenTarget(null)
          setReopenReason("")
          setReopenError(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reopen {reopenTarget ? monthLabel(reopenTarget.periodStart) : ""}</DialogTitle>
          </DialogHeader>
          {reopenError && (
            <Alert variant="destructive">
              <AlertDescription>{reopenError}</AlertDescription>
            </Alert>
          )}
          <p className="text-sm text-muted-foreground">Posting becomes possible again until this period is closed once more.</p>
          <Input placeholder="Reason for reopening" value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setReopenTarget(null)}>
              Back
            </Button>
            <Button
              disabled={pending || !reopenReason.trim()}
              onClick={() => {
                if (!reopenTarget) return
                startTransition(async () => {
                  const result = await reopenPeriodAction(reopenTarget.id, reopenReason)
                  if (result?.error) {
                    setReopenError(result.error)
                    return
                  }
                  setReopenTarget(null)
                  router.refresh()
                })
              }}
            >
              {pending ? "Reopening..." : "Reopen period"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
