"use client"

import { Plus, Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { createTemplateAction, updateTemplateAction, type ActionState } from "@/app/(dashboard)/communications/actions"

const initialState: ActionState = {}

type ExistingTemplate = {
  id: string
  key: string
  channel: string
  name: string
  subject: string | null
  body: string
}

export function TemplateDialog({ existing }: { existing?: ExistingTemplate }) {
  const action = existing ? updateTemplateAction : createTemplateAction
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
            <Plus /> New template
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit template" : "New template"}</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          {existing && <input type="hidden" name="templateId" value={existing.id} />}
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="key">Key</Label>
              <Input id="key" name="key" defaultValue={existing?.key} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="channel">Channel</Label>
              <Select name="channel" defaultValue={existing?.channel ?? "sms"} required>
                <SelectTrigger id="channel" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sms">SMS</SelectItem>
                  <SelectItem value="whatsapp">WhatsApp</SelectItem>
                  <SelectItem value="email">Email</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" defaultValue={existing?.name} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="subject">Subject (email only)</Label>
            <Input id="subject" name="subject" defaultValue={existing?.subject ?? ""} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="body">Body ({"{{variable}}"} placeholders)</Label>
            <Textarea id="body" name="body" rows={4} defaultValue={existing?.body} required />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : existing ? "Save changes" : "Create template"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
