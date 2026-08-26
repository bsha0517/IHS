"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { Switch } from "@/components/ui/switch"
import { setPortalClinicalReleaseAction } from "@/app/(dashboard)/admin/settings/actions"

export function PortalReleaseToggle({ enabled, canEdit }: { enabled: boolean; canEdit: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <Switch
      checked={enabled}
      disabled={pending || !canEdit}
      onCheckedChange={(checked: boolean) =>
        startTransition(async () => {
          await setPortalClinicalReleaseAction(checked)
          router.refresh()
        })
      }
    />
  )
}
