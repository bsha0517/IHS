"use client"

import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { setMappingAction, type ActionState } from "@/app/(dashboard)/accounting/actions"
import { postingIntents, POSTING_INTENT_LABELS } from "@/lib/domains/accounting/schemas"

const initialState: ActionState = {}

export function MappingDialog({
  accounts,
  branches,
}: {
  accounts: { id: string; code: string; name: string }[]
  branches: { id: string; name: string }[]
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(setMappingAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus /> Set mapping
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set account mapping</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="intent">Posting intent</Label>
            <Select name="intent" required>
              <SelectTrigger id="intent" className="w-full">
                <SelectValue placeholder="Select intent" />
              </SelectTrigger>
              <SelectContent>
                {postingIntents.map((i) => (
                  <SelectItem key={i} value={i}>
                    {POSTING_INTENT_LABELS[i]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="accountId">Account</Label>
            <Select name="accountId" required>
              <SelectTrigger id="accountId" className="w-full">
                <SelectValue placeholder="Select account" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.code} — {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="branchId">Branch (blank = organization default)</Label>
            <Select name="branchId">
              <SelectTrigger id="branchId" className="w-full">
                <SelectValue placeholder="Organization-wide default" />
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
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Save mapping"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
