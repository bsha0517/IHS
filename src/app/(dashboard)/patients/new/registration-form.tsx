"use client"

import Link from "next/link"
import { useRef, useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { FormSection } from "@/components/ui/form-section"
import { calculateAge, formatDate } from "@/lib/utils/dates"
import {
  checkDuplicatesAction,
  registerPatientAction,
  type ActionState,
} from "@/app/(dashboard)/patients/actions"
import type { DuplicateCandidate } from "@/lib/domains/patients/service"

type Option = { id: string; name: string }

export function RegistrationForm({
  branches,
  providers,
  defaultBranchId,
}: {
  branches: Option[]
  providers: { id: string; firstName: string; lastName: string }[]
  defaultBranchId: string | null
}) {
  const formRef = useRef<HTMLFormElement>(null)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[]>([])
  const [showDuplicateDialog, setShowDuplicateDialog] = useState(false)
  const [overrideReason, setOverrideReason] = useState("")

  async function doRegister(formData: FormData) {
    const result: ActionState = await registerPatientAction({}, formData)
    if (result?.error) setError(result.error)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!formRef.current) return
    const formData = new FormData(formRef.current)
    setError(undefined)

    startTransition(async () => {
      const result = await checkDuplicatesAction({}, formData)
      if (result.error) {
        setError(result.error)
        return
      }
      if (result.candidates && result.candidates.length > 0) {
        setDuplicates(result.candidates)
        setShowDuplicateDialog(true)
        return
      }
      await doRegister(formData)
    })
  }

  function handleConfirmDuplicate() {
    if (!formRef.current) return
    const formData = new FormData(formRef.current)
    formData.set("duplicateOverrideReason", overrideReason)
    setShowDuplicateDialog(false)
    startTransition(async () => {
      await doRegister(formData)
    })
  }

  return (
    <>
      <form ref={formRef} onSubmit={handleSubmit} className="grid gap-6">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* P4.7A.1 §35 — grouped via the shared FormSection primitive instead
            of each section hand-rolling its own `<p>` mini-heading. Field
            list and column counts are unchanged. */}
        <FormSection title="Identity" grid={false}>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="firstName">First name *</Label>
              <Input id="firstName" name="firstName" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="middleName">Middle name</Label>
              <Input id="middleName" name="middleName" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="lastName">Last name *</Label>
              <Input id="lastName" name="lastName" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="dob">Date of birth *</Label>
              <Input id="dob" name="dob" type="date" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="gender">Gender *</Label>
              <Select name="gender" required defaultValue="unknown">
                <SelectTrigger id="gender" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="male">Male</SelectItem>
                  <SelectItem value="female">Female</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                  <SelectItem value="unknown">Unknown</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="nationality">Nationality</Label>
              <Input id="nationality" name="nationality" />
            </div>
          </div>
        </FormSection>

        <FormSection title="Contact" grid={false}>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="mobile">Mobile *</Label>
              <Input id="mobile" name="mobile" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="whatsapp">WhatsApp</Label>
              <Input id="whatsapp" name="whatsapp" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" />
            </div>
            <div className="grid gap-2 sm:col-span-2">
              <Label htmlFor="addressLine">Address</Label>
              <Input id="addressLine" name="addressLine" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="city">City</Label>
              <Input id="city" name="city" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="country">Country</Label>
              <Input id="country" name="country" />
            </div>
          </div>
        </FormSection>

        <FormSection title="Identification" grid={false}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="nationalId">National ID</Label>
              <Input id="nationalId" name="nationalId" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="passportNumber">Passport number</Label>
              <Input id="passportNumber" name="passportNumber" />
            </div>
          </div>
        </FormSection>

        <FormSection title="Emergency contact" grid={false}>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="emergencyContactName">Name</Label>
              <Input id="emergencyContactName" name="emergencyContactName" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="emergencyContactRelationship">Relationship</Label>
              <Input id="emergencyContactRelationship" name="emergencyContactRelationship" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="emergencyContactPhone">Phone</Label>
              <Input id="emergencyContactPhone" name="emergencyContactPhone" />
            </div>
          </div>
        </FormSection>

        <FormSection title="Registration" grid={false}>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="registrationBranchId">Branch *</Label>
              <Select name="registrationBranchId" required defaultValue={defaultBranchId ?? undefined}>
                <SelectTrigger id="registrationBranchId" className="w-full">
                  <SelectValue placeholder="Select a branch" />
                </SelectTrigger>
                <SelectContent>
                  {branches.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="preferredProviderId">Preferred provider</Label>
              <Select name="preferredProviderId">
                <SelectTrigger id="preferredProviderId" className="w-full">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.firstName} {p.lastName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="preferredLanguage">Preferred language</Label>
              <Input id="preferredLanguage" name="preferredLanguage" />
            </div>
            <div className="grid gap-2 sm:col-span-2">
              <Label htmlFor="referralSource">Referral source</Label>
              <Input id="referralSource" name="referralSource" />
            </div>
          </div>
        </FormSection>

        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Checking..." : "Register Patient"}
          </Button>
        </div>
      </form>

      <Dialog open={showDuplicateDialog} onOpenChange={setShowDuplicateDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Possible existing patient(s) found</DialogTitle>
            <DialogDescription>
              This does not block registration — review, then confirm you still want to create a new record
              (spec.md §9). The reason you give is kept on the audit trail.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            {duplicates.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-3 rounded-md border border-border p-3 text-sm">
                <div>
                  <p className="font-medium">
                    {d.firstName} {d.lastName} — {d.mrn}
                  </p>
                  <p className="text-muted-foreground">
                    DOB {formatDate(d.dob)} ({calculateAge(d.dob)}y) · {d.mobile} {d.email ? `· ${d.email}` : ""}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">Matched on: {d.matchedOn.join(", ")}</p>
                </div>
                {/* P3.1 §11: opens in a new tab so the half-filled registration form here is never lost. */}
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/patients/${d.id}`} target="_blank" rel="noopener noreferrer">
                    Open record
                  </Link>
                </Button>
              </div>
            ))}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="overrideReason">Reason for registering a new record anyway</Label>
            <Textarea
              id="overrideReason"
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              placeholder="e.g. different person confirmed by ID check"
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDuplicateDialog(false)}>
              Go back and review
            </Button>
            <Button onClick={handleConfirmDuplicate} disabled={pending}>
              Register anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
