"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
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
   * arguments a closure would otherwise have captured. May return void (a
   * thrown rejection is caught below) or an `{error}`-shaped result — either
   * way this dialog surfaces a friendly message instead of failing silently.
   */
  action: (...args: [...TArgs, string]) => Promise<void | { error?: string }>
  args: TArgs
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

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
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Textarea placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
          <DialogFooter>
            <Button
              disabled={pending || !reason.trim()}
              onClick={() =>
                startTransition(async () => {
                  setError(null)
                  try {
                    const result = await action(...args, reason)
                    if (result?.error) {
                      setError(result.error)
                      return
                    }
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "This action failed.")
                    return
                  }
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
