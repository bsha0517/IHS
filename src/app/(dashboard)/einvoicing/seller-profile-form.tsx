"use client"

import { useActionState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { saveZatcaSellerProfileAction, type ActionState } from "@/app/(dashboard)/einvoicing/actions"
import type { ZatcaSellerProfile } from "@/lib/domains/einvoicing/config"

const initialState: ActionState = {}

export function SellerProfileForm({ profile, canEdit }: { profile: ZatcaSellerProfile; canEdit: boolean }) {
  const [state, formAction, pending] = useActionState(saveZatcaSellerProfileAction, initialState)

  return (
    <form action={formAction} className="grid gap-4">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.success && (
        <Alert>
          <AlertDescription>Saved.</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center gap-3">
        <Switch id="enabled" name="enabled" defaultChecked={profile.enabled} disabled={!canEdit} />
        <Label htmlFor="enabled">Enable ZATCA e-invoicing for this organization</Label>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="vatRegistrationNumber">VAT registration number</Label>
          <Input id="vatRegistrationNumber" name="vatRegistrationNumber" defaultValue={profile.vatRegistrationNumber} maxLength={15} disabled={!canEdit} placeholder="3XXXXXXXXXXXXX3" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="sellerName">Seller legal name</Label>
          <Input id="sellerName" name="sellerName" defaultValue={profile.sellerName} disabled={!canEdit} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="streetName">Street</Label>
          <Input id="streetName" name="streetName" defaultValue={profile.streetName} disabled={!canEdit} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="buildingNumber">Building number (4 digits)</Label>
          <Input id="buildingNumber" name="buildingNumber" defaultValue={profile.buildingNumber} maxLength={4} disabled={!canEdit} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="additionalNumber">Additional number</Label>
          <Input id="additionalNumber" name="additionalNumber" defaultValue={profile.additionalNumber} disabled={!canEdit} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="district">District</Label>
          <Input id="district" name="district" defaultValue={profile.district} disabled={!canEdit} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="city">City</Label>
          <Input id="city" name="city" defaultValue={profile.city} disabled={!canEdit} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="postalCode">Postal code</Label>
          <Input id="postalCode" name="postalCode" defaultValue={profile.postalCode} maxLength={5} disabled={!canEdit} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="countryCode">Country code</Label>
          <Input id="countryCode" name="countryCode" defaultValue={profile.countryCode} maxLength={2} disabled={!canEdit} />
        </div>
      </div>

      {canEdit && (
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving..." : "Save changes"}
          </Button>
        </div>
      )}
    </form>
  )
}
