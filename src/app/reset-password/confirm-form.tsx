"use client"

import { useActionState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { confirmPasswordResetAction, type ResetConfirmState } from "@/app/reset-password/actions"

const initialState: ResetConfirmState = {}

export function ConfirmResetForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState(confirmPasswordResetAction, initialState)

  if (state.success) {
    return (
      <div className="grid gap-4">
        <Alert>
          <AlertDescription>Your password has been reset. All existing sessions have been signed out.</AlertDescription>
        </Alert>
        <Button asChild className="w-full">
          <Link href="/login">Sign in</Link>
        </Button>
      </div>
    )
  }

  return (
    <form action={formAction} className="grid gap-4">
      <input type="hidden" name="token" value={token} />

      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-2">
        <Label htmlFor="password">New password</Label>
        <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={8} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="confirmPassword">Confirm new password</Label>
        <Input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" required minLength={8} />
      </div>

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Resetting..." : "Reset password"}
      </Button>
    </form>
  )
}
