"use client"

import { useActionState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { updatePortalProfileAction, type PortalProfileFormState } from "@/app/portal/actions"

const initialState: PortalProfileFormState = {}

export function ProfileForm({
  mobile,
  email,
  addressLine,
  city,
}: {
  mobile: string
  email: string | null
  addressLine: string | null
  city: string | null
}) {
  const [state, formAction, pending] = useActionState(updatePortalProfileAction, initialState)

  return (
    <form action={formAction} className="grid gap-4 sm:max-w-md">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.success && (
        <Alert>
          <AlertDescription>Your information has been updated.</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-2">
        <Label htmlFor="mobile">Mobile</Label>
        <Input id="mobile" name="mobile" defaultValue={mobile} required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" defaultValue={email ?? ""} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="addressLine">Address</Label>
        <Input id="addressLine" name="addressLine" defaultValue={addressLine ?? ""} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="city">City</Label>
        <Input id="city" name="city" defaultValue={city ?? ""} />
      </div>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving..." : "Save changes"}
        </Button>
      </div>
    </form>
  )
}
