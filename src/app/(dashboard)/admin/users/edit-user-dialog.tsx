"use client"

import { Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { updateUserAction, type ActionState } from "@/app/(dashboard)/admin/users/actions"

const initialState: ActionState = {}

type EditableUser = {
  id: string
  firstName: string
  lastName: string
  status: "active" | "inactive" | "locked"
  roles: { roleId: string }[]
  branchAccess: { branchId: string }[]
}

/**
 * P3.12 §16: the "see and manage a user's authorized branches" half of the
 * requirement — creation already collected roles/branches, nothing let an
 * Admin change them afterward. `isSelf` disables the roles group entirely
 * (P3.12 §28 self-escalation guard lives server-side in `updateUser`; this
 * just avoids showing a control that would always be rejected — §52).
 */
export function EditUserDialog({
  user,
  roles,
  branches,
  isSelf,
}: {
  user: EditableUser
  roles: { id: string; name: string }[]
  branches: { id: string; name: string }[]
  isSelf: boolean
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(updateUserAction, initialState)
  const currentRoleIds = new Set(user.roles.map((r) => r.roleId))
  const currentBranchIds = new Set(user.branchAccess.map((a) => a.branchId))

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost">
          <Pencil /> Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Edit {user.firstName} {user.lastName}
          </DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <input type="hidden" name="userId" value={user.id} />

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor={`edit-firstName-${user.id}`}>First name</Label>
              <Input id={`edit-firstName-${user.id}`} name="firstName" defaultValue={user.firstName} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`edit-lastName-${user.id}`}>Last name</Label>
              <Input id={`edit-lastName-${user.id}`} name="lastName" defaultValue={user.lastName} required />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor={`edit-status-${user.id}`}>Status</Label>
            <Select name="status" defaultValue={user.status}>
              <SelectTrigger id={`edit-status-${user.id}`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
                {user.status === "locked" && <SelectItem value="locked">Locked (auto-expires)</SelectItem>}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label>Roles</Label>
            {isSelf ? (
              <p className="rounded-md border border-border p-3 text-sm text-muted-foreground">
                You cannot change your own role assignment here. Ask another administrator.
              </p>
            ) : (
              <div className="grid gap-2 rounded-md border border-border p-3">
                <input type="hidden" name="rolesFieldPresent" value="1" />
                {roles.map((role) => (
                  <label key={role.id} className="flex items-center gap-2 text-sm">
                    <Checkbox name="roleIds" value={role.id} defaultChecked={currentRoleIds.has(role.id)} />
                    {role.name}
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="grid gap-2">
            <Label>Branch access</Label>
            <div className="grid gap-2 rounded-md border border-border p-3">
              <input type="hidden" name="branchesFieldPresent" value="1" />
              {branches.map((branch) => (
                <label key={branch.id} className="flex items-center gap-2 text-sm">
                  <Checkbox name="branchIds" value={branch.id} defaultChecked={currentBranchIds.has(branch.id)} />
                  {branch.name}
                </label>
              ))}
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
