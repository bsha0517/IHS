"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { KeyRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import {
  enablePortalAccessAction,
  resetPortalPasswordAction,
  deactivatePortalAccessAction,
  type PortalActionState,
} from "@/app/(dashboard)/patients/actions"

const initialState: PortalActionState = {}

export function PortalAccessCard({
  patientId,
  account,
}: {
  patientId: string
  account: { email: string; status: string } | null
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<PortalActionState>(initialState)
  const [pending, startTransition] = useTransition()

  function handleEnable(formData: FormData) {
    startTransition(async () => {
      const result = await enablePortalAccessAction(initialState, formData)
      setState(result)
      if (result.success) router.refresh()
    })
  }

  function handleReset() {
    startTransition(async () => {
      const result = await resetPortalPasswordAction(patientId)
      setState(result)
    })
  }

  function handleDeactivate() {
    startTransition(async () => {
      await deactivatePortalAccessAction(patientId)
      router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Patient Portal</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {!account ? (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <KeyRound className="size-3.5" /> Enable portal access
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-sm">
              <DialogHeader>
                <DialogTitle>Enable portal access</DialogTitle>
              </DialogHeader>
              <form action={handleEnable} className="grid gap-4">
                <input type="hidden" name="patientId" value={patientId} />
                {state.error && (
                  <Alert variant="destructive">
                    <AlertDescription>{state.error}</AlertDescription>
                  </Alert>
                )}
                {state.tempPassword ? (
                  <Alert>
                    <AlertDescription>
                      Portal account created. Temporary password (relay to the patient, shown once): <strong>{state.tempPassword}</strong>
                    </AlertDescription>
                  </Alert>
                ) : (
                  <div className="grid gap-2">
                    <Label htmlFor="email">Email</Label>
                    <Input id="email" name="email" type="email" required />
                  </div>
                )}
                <DialogFooter>
                  {!state.tempPassword && (
                    <Button type="submit" disabled={pending}>
                      {pending ? "Creating..." : "Create account"}
                    </Button>
                  )}
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <span>{account.email}</span>
              <Badge variant={account.status === "active" ? "default" : "secondary"}>{account.status}</Badge>
            </div>
            {state.tempPassword && (
              <Alert>
                <AlertDescription>
                  New temporary password (relay to the patient, shown once): <strong>{state.tempPassword}</strong>
                </AlertDescription>
              </Alert>
            )}
            {state.error && (
              <Alert variant="destructive">
                <AlertDescription>{state.error}</AlertDescription>
              </Alert>
            )}
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={pending} onClick={handleReset}>
                Reset password
              </Button>
              {account.status === "active" && (
                <Button size="sm" variant="ghost" disabled={pending} onClick={handleDeactivate}>
                  Deactivate
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
