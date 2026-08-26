"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"

export function ReasonDialog<TArgs extends unknown[]>({
  triggerLabel,
  title,
  variant = "outline",
  action,
  args,
}: {
  triggerLabel: string
  title: string
  variant?: "outline" | "destructive" | "default"
  /**
   * A genuine "use server" export, passed by reference — not an inline
   * closure. A Server Component can hand a Client Component a real Server
   * Action reference, but not an ad-hoc arrow function wrapping one (Next.js
   * rejects that at the RSC boundary); `args` carries the extra positional
   * arguments a closure would otherwise have captured.
   */
  action: (...args: [...TArgs, string]) => Promise<void>
  args: TArgs
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [pending, startTransition] = useTransition()

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant={variant}>
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <Textarea placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
          <DialogFooter>
            <Button
              disabled={pending || !reason.trim()}
              onClick={() =>
                startTransition(async () => {
                  await action(...args, reason)
                  setOpen(false)
                  router.refresh()
                })
              }
            >
              {pending ? "Saving..." : "Confirm"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
