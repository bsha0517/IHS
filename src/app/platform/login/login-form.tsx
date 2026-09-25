"use client"

import { useActionState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { platformLoginAction, type PlatformLoginFormState } from "@/app/platform/login/actions"

const initialState: PlatformLoginFormState = {}

export function PlatformLoginForm({ from }: { from?: string }) {
  const [state, formAction, pending] = useActionState(platformLoginAction, initialState)

  return (
    <form action={formAction} className="grid gap-4">
      <input type="hidden" name="from" value={from ?? ""} />

      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="username" required />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="password">Password</Label>
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Signing in..." : "Sign in"}
      </Button>
    </form>
  )
}
