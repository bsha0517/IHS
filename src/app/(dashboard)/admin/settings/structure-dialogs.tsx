"use client"

import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import {
  createBranchAction,
  createDepartmentAction,
  createRoomAction,
  type ActionState,
} from "@/app/(dashboard)/admin/settings/actions"

const initialState: ActionState = {}

export function BranchDialog() {
  const { open, setOpen, state, pending, submit } = useActionDialog(createBranchAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus /> Add branch
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add branch</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="branch-name">Name</Label>
            <Input id="branch-name" name="name" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="branch-code">Code</Label>
            <Input id="branch-code" name="code" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="branch-timezone">Timezone (IANA)</Label>
            <Input id="branch-timezone" name="timezone" placeholder="Asia/Dubai" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="branch-address">Address</Label>
            <Input id="branch-address" name="address" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="branch-phone">Phone</Label>
            <Input id="branch-phone" name="phone" />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating..." : "Create branch"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function DepartmentDialog({ branches }: { branches: { id: string; name: string }[] }) {
  const { open, setOpen, state, pending, submit } = useActionDialog(createDepartmentAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={branches.length === 0}>
          <Plus /> Add department
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add department</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="department-branch">Branch</Label>
            <Select name="branchId" required>
              <SelectTrigger id="department-branch" className="w-full">
                <SelectValue placeholder="Select a branch" />
              </SelectTrigger>
              <SelectContent>
                {branches.map((branch) => (
                  <SelectItem key={branch.id} value={branch.id}>
                    {branch.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="department-name">Name</Label>
            <Input id="department-name" name="name" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="department-code">Code</Label>
            <Input id="department-code" name="code" required />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating..." : "Create department"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function RoomDialog({ departments }: { departments: { id: string; name: string }[] }) {
  const { open, setOpen, state, pending, submit } = useActionDialog(createRoomAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={departments.length === 0}>
          <Plus /> Add room
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add room</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="room-department">Department</Label>
            <Select name="departmentId" required>
              <SelectTrigger id="room-department" className="w-full">
                <SelectValue placeholder="Select a department" />
              </SelectTrigger>
              <SelectContent>
                {departments.map((department) => (
                  <SelectItem key={department.id} value={department.id}>
                    {department.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="room-name">Name</Label>
            <Input id="room-name" name="name" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="room-code">Code</Label>
            <Input id="room-code" name="code" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="room-type">Room type</Label>
            <Input id="room-type" name="roomType" placeholder="consultation, procedure, ..." required />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating..." : "Create room"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
