"use client"

import { useActionState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { updateRolePermissionsAction, type ActionState } from "@/app/(dashboard)/admin/roles/actions"

type Permission = { id: string; code: string; category: string; description: string }

const initialState: ActionState = {}

export function RolePermissionEditor({
  role,
  permissionsByCategory,
}: {
  role: { id: string; name: string; isSystemRole: boolean; permissionIds: Set<string> }
  permissionsByCategory: [string, Permission[]][]
}) {
  const [state, formAction, pending] = useActionState(updateRolePermissionsAction, initialState)

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base">
          {role.name}
          {role.isSystemRole && <Badge variant="secondary">System role</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {state.error && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        )}
        <form action={formAction} className="grid gap-4">
          <input type="hidden" name="roleId" value={role.id} />
          <div className="grid gap-4 sm:grid-cols-2">
            {permissionsByCategory.map(([category, permissions]) => (
              <div key={category} className="grid gap-1.5">
                <p className="text-xs font-medium uppercase text-muted-foreground">{category}</p>
                {permissions.map((permission) => (
                  <label key={permission.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      name="permissionIds"
                      value={permission.id}
                      defaultChecked={role.permissionIds.has(permission.id)}
                      disabled={role.isSystemRole}
                    />
                    {permission.code}
                  </label>
                ))}
              </div>
            ))}
          </div>
          {!role.isSystemRole && (
            <div>
              <Button type="submit" size="sm" disabled={pending}>
                {pending ? "Saving..." : "Save permissions"}
              </Button>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  )
}
