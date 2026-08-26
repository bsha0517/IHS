"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { sendReminderAction, sendPaymentReminderAction, sendBirthdayGreetingAction } from "@/app/(dashboard)/communications/actions"

export function SendReminderButton({
  patientId,
  patientName,
  appointmentId,
  providerName,
  appointmentDate,
}: {
  patientId: string
  patientName: string
  appointmentId: string
  providerName: string
  appointmentDate: Date
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await sendReminderAction(patientId, patientName, appointmentId, providerName, appointmentDate)
          router.refresh()
        })
      }
    >
      <Send className="size-3.5" /> {pending ? "Sending..." : "Send reminder"}
    </Button>
  )
}

export function SendPaymentReminderButton({
  patientId,
  patientName,
  invoiceId,
  invoiceNumber,
  outstandingAmount,
}: {
  patientId: string
  patientName: string
  invoiceId: string
  invoiceNumber: string
  outstandingAmount: number
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await sendPaymentReminderAction(patientId, patientName, invoiceId, invoiceNumber, outstandingAmount)
          router.refresh()
        })
      }
    >
      <Send className="size-3.5" /> {pending ? "Sending..." : "Send reminder"}
    </Button>
  )
}

export function SendBirthdayGreetingButton({ patientId, patientName }: { patientId: string; patientName: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await sendBirthdayGreetingAction(patientId, patientName)
          router.refresh()
        })
      }
    >
      <Send className="size-3.5" /> {pending ? "Sending..." : "Send greeting"}
    </Button>
  )
}
