"use client"

import { useActionState, useState, useMemo } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { FormSection, FormFieldFull } from "@/components/ui/form-section"
import { MODULE_KEYS, MODULE_LABELS } from "@/lib/platform/entitlements-shared"
import { provisionClinicAction, type ProvisionState } from "@/app/platform/provision/actions"

const initialState: ProvisionState = {}

/**
 * P5.1 §24/§60: one deliberate workflow (Commercial Details -> Plan ->
 * Initial Branch -> Initial Admin -> Modules), not scattered pages. The
 * idempotency key is generated once at MOUNT (useState initializer, not on
 * every render/submit) and resubmitted unchanged on any retry of this same
 * attempt — a fresh key per click would defeat idempotency entirely (see
 * idempotency.ts's own doc comment, which this mirrors).
 */
export function ProvisionForm({ plans }: { plans: { id: string; code: string; name: string; defaultModuleKeys: string[] }[] }) {
  const [state, formAction, pending] = useActionState<ProvisionState, FormData>(provisionClinicAction, initialState)
  const [idempotencyKey] = useState(() => crypto.randomUUID())
  const [planId, setPlanId] = useState(plans[0]?.id ?? "")
  const [selectedModules, setSelectedModules] = useState<string[]>(plans[0]?.defaultModuleKeys ?? [])

  const selectedPlan = useMemo(() => plans.find((p) => p.id === planId), [plans, planId])

  if (state.success) {
    return (
      <Alert>
        <AlertTitle>Clinic provisioned — {state.success.customerCode}</AlertTitle>
        <AlertDescription className="grid gap-2">
          <p>
            Organization created and its initial administrator ({state.success.adminEmail}) established. The one-time activation link below is shown ONLY
            now — it cannot be recovered afterward. Relay it to the clinic through a secure channel of your choosing.
          </p>
          <code className="block break-all rounded-md border border-border bg-muted p-2 text-xs">
            {`/reset-password?token=${state.success.activationToken}`}
          </code>
          <Button asChild size="sm" className="justify-self-start">
            <Link href={`/platform/organizations/${state.success.organizationId}`}>Open organization</Link>
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <form action={formAction} className="grid gap-6">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      <FormSection title="Organization">
        <div className="grid gap-1.5">
          <Label htmlFor="displayName">Display name</Label>
          <Input id="displayName" name="displayName" required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="legalName">Legal name</Label>
          <Input id="legalName" name="legalName" required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="defaultCurrency">Default currency (ISO-3)</Label>
          <Input id="defaultCurrency" name="defaultCurrency" maxLength={3} defaultValue="USD" required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="defaultTimezone">Default timezone</Label>
          <Input id="defaultTimezone" name="defaultTimezone" defaultValue="Asia/Karachi" required />
        </div>
      </FormSection>

      <FormSection title="Commercial details">
        <div className="grid gap-1.5">
          <Label htmlFor="country">Country (ISO-2)</Label>
          <Input id="country" name="country" maxLength={2} placeholder="PK, AE, SA..." required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="legalBusinessName">Legal business name (if distinct)</Label>
          <Input id="legalBusinessName" name="legalBusinessName" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="primaryContactName">Primary contact</Label>
          <Input id="primaryContactName" name="primaryContactName" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="primaryContactEmail">Primary contact email</Label>
          <Input id="primaryContactEmail" name="primaryContactEmail" type="email" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="primaryContactPhone">Primary contact phone</Label>
          <Input id="primaryContactPhone" name="primaryContactPhone" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="implementationOwner">Implementation owner</Label>
          <Input id="implementationOwner" name="implementationOwner" placeholder="Who at Avant is implementing this clinic" />
        </div>
        <FormFieldFull>
          <Label htmlFor="internalNotes">Internal notes</Label>
          <Textarea id="internalNotes" name="internalNotes" rows={2} />
        </FormFieldFull>
      </FormSection>

      <FormSection title="Plan / subscription">
        <div className="grid gap-1.5">
          <Label htmlFor="planId">Plan</Label>
          <Select
            name="planId"
            value={planId}
            onValueChange={(value) => {
              setPlanId(value)
              setSelectedModules(plans.find((p) => p.id === value)?.defaultModuleKeys ?? [])
            }}
          >
            <SelectTrigger id="planId" className="w-full">
              <SelectValue placeholder="Select a plan" />
            </SelectTrigger>
            <SelectContent>
              {plans.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name} ({p.code})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="subscriptionStatus">Subscription status</Label>
          <Select name="subscriptionStatus" defaultValue="trial">
            <SelectTrigger id="subscriptionStatus" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="trial">Trial</SelectItem>
              <SelectItem value="active">Active</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="startDate">Start date</Label>
          <Input id="startDate" name="startDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="trialEndsAt">Trial ends</Label>
          <Input id="trialEndsAt" name="trialEndsAt" type="date" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="agreedUserLimit">Agreed user limit (blank = plan default)</Label>
          <Input id="agreedUserLimit" name="agreedUserLimit" type="number" min={1} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="agreedBranchLimit">Agreed branch limit (blank = plan default)</Label>
          <Input id="agreedBranchLimit" name="agreedBranchLimit" type="number" min={1} />
        </div>
      </FormSection>

      <FormSection title="Initial branch">
        <div className="grid gap-1.5">
          <Label htmlFor="branchName">Branch name</Label>
          <Input id="branchName" name="branchName" required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="branchCode">Branch code</Label>
          <Input id="branchCode" name="branchCode" required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="branchAddress">Address</Label>
          <Input id="branchAddress" name="branchAddress" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="branchPhone">Phone</Label>
          <Input id="branchPhone" name="branchPhone" />
        </div>
      </FormSection>

      <FormSection title="Initial administrator" grid={false}>
        <p className="text-xs text-muted-foreground">
          No password is set here — a secure, one-time activation link is issued after provisioning (shown once, below) so the admin sets their own password.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor="adminFirstName">First name</Label>
            <Input id="adminFirstName" name="adminFirstName" required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="adminLastName">Last name</Label>
            <Input id="adminLastName" name="adminLastName" required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="adminEmail">Email</Label>
            <Input id="adminEmail" name="adminEmail" type="email" required />
          </div>
        </div>
      </FormSection>

      <FormSection title="Modules" grid={false}>
        <p className="text-xs text-muted-foreground">
          Defaults to {selectedPlan?.name ?? "the selected plan"}&apos;s own module list — adjust for this specific clinic if the contract differs.
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {MODULE_KEYS.map((key) => (
            <label key={key} className="flex items-center gap-2 rounded-md border border-border p-2 text-sm">
              <Checkbox
                name="moduleKeys"
                value={key}
                checked={selectedModules.includes(key)}
                onCheckedChange={(checked) =>
                  setSelectedModules((prev) => (checked === true ? [...prev, key] : prev.filter((k) => k !== key)))
                }
              />
              {MODULE_LABELS[key]}
            </label>
          ))}
        </div>
      </FormSection>

      <Button type="submit" disabled={pending || !planId} className="justify-self-start">
        {pending ? "Provisioning..." : "Provision clinic"}
      </Button>
    </form>
  )
}
