"use client"

import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { createRoleAction, type ActionState } from "@/app/(dashboard)/admin/roles/actions"

type Permission = { id: string; code: string; category: string }

const initialState: ActionState = {}

export function NewRoleDialog({ permissionsByCategory }: { permissionsByCategory: [string, Permission[]][] }) {
  const { open, setOpen, state, pending, submit } = useActionDialog(createRoleAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus /> New role
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New role</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="role-name">Name</Label>
            <Input id="role-name" name="name" required />
          </div>
          <div className="grid gap-4">
            {permissionsByCategory.map(([category, permissions]) => (
              <div key={category} className="grid gap-1.5">
                <p className="text-xs font-medium uppercase text-muted-foreground">{category}</p>
                {permissions.map((permission) => (
                  <label key={permission.id} className="flex items-center gap-2 text-sm">
                    <Checkbox name="permissionIds" value={permission.id} />
                    {permission.code}
                  </label>
                ))}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating..." : "Create role"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
