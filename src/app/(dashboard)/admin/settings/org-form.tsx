"use client"

import { useActionState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { updateOrganizationAction, type ActionState } from "@/app/(dashboard)/admin/settings/actions"

const initialState: ActionState = {}

export function OrgForm({
  organization,
}: {
  organization: { legalName: string; displayName: string; defaultCurrency: string; defaultTimezone: string }
}) {
  const [state, formAction, pending] = useActionState(updateOrganizationAction, initialState)

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-2">
      {state.error && (
        <Alert variant="destructive" className="sm:col-span-2">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.success && (
        <Alert className="sm:col-span-2">
          <AlertDescription>Saved.</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-2">
        <Label htmlFor="legalName">Legal name</Label>
        <Input id="legalName" name="legalName" defaultValue={organization.legalName} required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="displayName">Display name</Label>
        <Input id="displayName" name="displayName" defaultValue={organization.displayName} required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="defaultCurrency">Default currency (ISO 4217)</Label>
        <Input id="defaultCurrency" name="defaultCurrency" defaultValue={organization.defaultCurrency} maxLength={3} required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="defaultTimezone">Default timezone (IANA)</Label>
        <Input id="defaultTimezone" name="defaultTimezone" defaultValue={organization.defaultTimezone} required />
      </div>

      <div className="sm:col-span-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving..." : "Save changes"}
        </Button>
      </div>
    </form>
  )
}
