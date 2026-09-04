"use client"

import { Plus, Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { FormSection, FormFieldFull } from "@/components/ui/form-section"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { createEmployeeAction, updateEmployeeAction, type ActionState } from "@/app/(dashboard)/employees/actions"

const initialState: ActionState = {}
const EMPLOYMENT_TYPES = ["full_time", "part_time", "contract", "intern"] as const

type ExistingEmployee = {
  id: string
  branchId: string
  departmentId: string | null
  firstName: string
  lastName: string
  designation: string
  managerId: string | null
  joiningDate: string
  employmentType: string
  basicSalary: number
  bankDetails: string | null
}

export function EmployeeDialog({
  branches,
  departments,
  managers,
  existing,
}: {
  branches: { id: string; name: string }[]
  departments: { id: string; name: string }[]
  managers: { id: string; firstName: string; lastName: string }[]
  existing?: ExistingEmployee
}) {
  const action = existing ? updateEmployeeAction : createEmployeeAction
  const { open, setOpen, state, pending, submit } = useActionDialog(action, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {existing ? (
          <Button size="icon-sm" variant="ghost" aria-label="Edit">
            <Pencil className="size-3.5" />
          </Button>
        ) : (
          <Button size="sm">
            <Plus /> New employee
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit employee" : "New employee"}</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          {existing && <input type="hidden" name="employeeId" value={existing.id} />}
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          {/* P4.7A.1 §34/§35 — grouped via the shared FormSection primitive;
              field list and layout are unchanged, just labeled sections
              instead of an unbroken stack of two-column rows. */}
          <FormSection title="Identity">
            <div className="grid gap-2">
              <Label htmlFor="firstName">First name</Label>
              <Input id="firstName" name="firstName" defaultValue={existing?.firstName} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="lastName">Last name</Label>
              <Input id="lastName" name="lastName" defaultValue={existing?.lastName} required />
            </div>
          </FormSection>

          <FormSection title="Assignment">
            <div className="grid gap-2">
              <Label htmlFor="branchId">Branch</Label>
              <Select name="branchId" defaultValue={existing?.branchId} required>
                <SelectTrigger id="branchId" className="w-full">
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
              <Label htmlFor="departmentId">Department</Label>
              <Select name="departmentId" defaultValue={existing?.departmentId ?? undefined}>
                <SelectTrigger id="departmentId" className="w-full">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="designation">Designation</Label>
              <Input id="designation" name="designation" defaultValue={existing?.designation} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="employmentType">Employment type</Label>
              <Select name="employmentType" defaultValue={existing?.employmentType} required>
                <SelectTrigger id="employmentType" className="w-full">
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  {EMPLOYMENT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t.replace("_", " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="managerId">Manager</Label>
              <Select name="managerId" defaultValue={existing?.managerId ?? undefined}>
                <SelectTrigger id="managerId" className="w-full">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  {managers
                    .filter((m) => m.id !== existing?.id)
                    .map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.firstName} {m.lastName}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="joiningDate">Joining date</Label>
              <Input
                id="joiningDate"
                name="joiningDate"
                type="date"
                defaultValue={existing?.joiningDate ?? new Date().toISOString().slice(0, 10)}
                required
              />
            </div>
          </FormSection>

          <FormSection title="Compensation">
            <div className="grid gap-2">
              <Label htmlFor="basicSalary">Basic salary</Label>
              <Input id="basicSalary" name="basicSalary" type="number" min="0" step="0.01" defaultValue={existing?.basicSalary ?? 0} required />
            </div>
            <FormFieldFull>
              <div className="grid gap-2">
                <Label htmlFor="bankDetails">Bank details</Label>
                <Textarea id="bankDetails" name="bankDetails" defaultValue={existing?.bankDetails ?? ""} />
              </div>
            </FormFieldFull>
          </FormSection>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : existing ? "Save changes" : "Create employee"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
