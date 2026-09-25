"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { updateSupportTicketStatusAction } from "@/app/platform/tickets/actions"
import type { $Enums } from "@/generated/prisma/client"

const STATUSES: $Enums.SupportTicketStatus[] = ["open", "in_progress", "waiting_on_customer", "resolved", "closed"]

export function TicketStatusSelect({ ticketId, status }: { ticketId: string; status: $Enums.SupportTicketStatus }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <Select
      defaultValue={status}
      disabled={pending}
      onValueChange={(value) =>
        startTransition(async () => {
          await updateSupportTicketStatusAction(ticketId, value as $Enums.SupportTicketStatus)
          router.refresh()
        })
      }
    >
      <SelectTrigger className="w-48">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {STATUSES.map((s) => (
          <SelectItem key={s} value={s}>
            {s.replace(/_/g, " ")}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
