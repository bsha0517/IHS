"use client"

import { useActionState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { openCashierSessionAction, type ActionState } from "@/app/(dashboard)/pos/actions"

const initialState: ActionState = {}

export function OpenRegisterForm({ branches }: { branches: { id: string; name: string }[] }) {
  const [state, formAction, pending] = useActionState(openCashierSessionAction, initialState)

  return (
    <Card className="mx-auto max-w-md">
      <CardHeader>
        <CardTitle>Open register</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="grid gap-4">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="branchId">Branch</Label>
            <Select name="branchId" required defaultValue={branches.length === 1 ? branches[0].id : undefined}>
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
            <Label htmlFor="openingCash">Opening cash</Label>
            <Input id="openingCash" name="openingCash" type="number" step="0.01" min="0" defaultValue="0" required />
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? "Opening..." : "Open register"}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
