"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Link2, Link2Off } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { linkEmployeeUserAction, unlinkEmployeeUserAction, type ActionState } from "@/app/(dashboard)/employees/actions"

const initialState: ActionState = {}

/**
 * P3.12 §14: resolves the P3.10 backlog item ("Employee<->User linking has
 * no UI"). Admin-only in practice — `unlinkedUsers` is only ever non-empty
 * for a caller holding `users.manage` (see `listUnlinkedUsers`), and the
 * domain functions re-check that permission server-side regardless of
 * what this component renders.
 */
export function UserLinkDialog({
  employeeId,
  unlinkedUsers,
}: {
  employeeId: string
  unlinkedUsers: { id: string; firstName: string; lastName: string; email: string }[]
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(linkEmployeeUserAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={unlinkedUsers.length === 0}>
          <Link2 /> Link user
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link to a system login</DialogTitle>
          <DialogDescription>
            Connects this employee record to an existing user account. Does not create a new login — the user must already exist under Admin → Users.
          </DialogDescription>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <input type="hidden" name="employeeId" value={employeeId} />
          <Select name="userId" required>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select a user" />
            </SelectTrigger>
            <SelectContent>
              {unlinkedUsers.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.firstName} {u.lastName} ({u.email})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Linking..." : "Link"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function UnlinkUserButton({ employeeId }: { employeeId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          try {
            await unlinkEmployeeUserAction(employeeId)
            router.refresh()
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Failed to unlink user.")
          }
        })
      }
    >
      <Link2Off /> {pending ? "Unlinking..." : "Unlink"}
    </Button>
  )
}
