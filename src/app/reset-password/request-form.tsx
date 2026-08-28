"use client"

import { useActionState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { requestPasswordResetAction, type ResetRequestState } from "@/app/reset-password/actions"

const initialState: ResetRequestState = {}

export function RequestResetForm() {
  const [state, formAction, pending] = useActionState(requestPasswordResetAction, initialState)

  if (state.submitted) {
    return (
      <div className="grid gap-4">
        <Alert>
          <AlertDescription>
            If an account with that email exists, a reset link would be sent to it. Email delivery is not currently
            configured in this environment — contact an administrator to reset your password.
          </AlertDescription>
        </Alert>
        <Button asChild variant="outline" className="w-full">
          <Link href="/login">Back to sign in</Link>
        </Button>
      </div>
    )
  }

  return (
    <form action={formAction} className="grid gap-4">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="username" required />
      </div>

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Submitting..." : "Send reset instructions"}
      </Button>
      <Button asChild variant="ghost" className="w-full">
        <Link href="/login">Back to sign in</Link>
      </Button>
    </form>
  )
}
