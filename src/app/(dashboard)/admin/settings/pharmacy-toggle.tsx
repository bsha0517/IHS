"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { Switch } from "@/components/ui/switch"
import { setPharmacyEnabledAction } from "@/app/(dashboard)/pharmacy/actions"

export function PharmacyToggle({ enabled, canEdit }: { enabled: boolean; canEdit: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <Switch
      checked={enabled}
      disabled={pending || !canEdit}
      onCheckedChange={(checked: boolean) =>
        startTransition(async () => {
          await setPharmacyEnabledAction(checked)
          router.refresh()
        })
      }
    />
  )
}
