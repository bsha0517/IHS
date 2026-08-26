"use client"

import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { addCalibrationRecordAction, type ActionState } from "@/app/(dashboard)/assets/actions"

const initialState: ActionState = {}

export function CalibrationDialog({ assetId }: { assetId: string }) {
  const { open, setOpen, state, pending, submit } = useActionDialog(addCalibrationRecordAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus /> Log calibration
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Log calibration</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="assetId" value={assetId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="calibrationDate">Calibration date</Label>
              <Input id="calibrationDate" name="calibrationDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="result">Result</Label>
              <Select name="result" required>
                <SelectTrigger id="result" className="w-full">
                  <SelectValue placeholder="Select result" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pass">Pass</SelectItem>
                  <SelectItem value="fail">Fail</SelectItem>
                  <SelectItem value="conditional">Conditional</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="certificateNumber">Certificate #</Label>
              <Input id="certificateNumber" name="certificateNumber" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="provider">Provider</Label>
              <Input id="provider" name="provider" />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="nextCalibrationDate">Next calibration</Label>
            <Input id="nextCalibrationDate" name="nextCalibrationDate" type="date" />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Log calibration"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
