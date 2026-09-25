"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { FormSection, FormFieldFull } from "@/components/ui/form-section"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { updateCommercialProfileAction, type ActionState } from "@/app/platform/organizations/[id]/actions"

const initialState: ActionState = {}

type CommercialProfileFields = {
  legalBusinessName: string | null
  primaryContactName: string | null
  primaryContactEmail: string | null
  primaryContactPhone: string | null
  billingContactName: string | null
  billingContactEmail: string | null
  country: string
  implementationOwner: string | null
  internalNotes: string | null
}

export function CommercialProfileDialog({ organizationId, profile }: { organizationId: string; profile: CommercialProfileFields }) {
  const boundAction = updateCommercialProfileAction.bind(null, organizationId)
  const { open, setOpen, state, pending, submit } = useActionDialog(boundAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Edit commercial details
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Commercial details</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <FormSection title="Business identity">
            <div className="grid gap-1.5">
              <Label htmlFor="legalBusinessName">Legal business name</Label>
              <Input id="legalBusinessName" name="legalBusinessName" defaultValue={profile.legalBusinessName ?? ""} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="country">Country (ISO-2)</Label>
              <Input id="country" name="country" defaultValue={profile.country} maxLength={2} required />
            </div>
          </FormSection>
          <FormSection title="Contacts">
            <div className="grid gap-1.5">
              <Label htmlFor="primaryContactName">Primary contact</Label>
              <Input id="primaryContactName" name="primaryContactName" defaultValue={profile.primaryContactName ?? ""} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="primaryContactEmail">Primary contact email</Label>
              <Input id="primaryContactEmail" name="primaryContactEmail" type="email" defaultValue={profile.primaryContactEmail ?? ""} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="primaryContactPhone">Primary contact phone</Label>
              <Input id="primaryContactPhone" name="primaryContactPhone" defaultValue={profile.primaryContactPhone ?? ""} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="billingContactName">Billing contact</Label>
              <Input id="billingContactName" name="billingContactName" defaultValue={profile.billingContactName ?? ""} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="billingContactEmail">Billing contact email</Label>
              <Input id="billingContactEmail" name="billingContactEmail" type="email" defaultValue={profile.billingContactEmail ?? ""} />
            </div>
          </FormSection>
          <FormSection title="Implementation" grid={false}>
            <div className="grid gap-1.5">
              <Label htmlFor="implementationOwner">Implementation owner</Label>
              <Input id="implementationOwner" name="implementationOwner" defaultValue={profile.implementationOwner ?? ""} placeholder="Who at Avant is implementing this clinic" />
            </div>
            <FormFieldFull>
              <Label htmlFor="internalNotes">Internal notes</Label>
              <Textarea id="internalNotes" name="internalNotes" defaultValue={profile.internalNotes ?? ""} rows={3} />
            </FormFieldFull>
          </FormSection>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
