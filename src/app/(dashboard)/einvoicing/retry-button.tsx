"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { retryEInvoiceSubmissionAction } from "@/app/(dashboard)/einvoicing/actions"

export function EInvoiceRetryButton({ invoiceId }: { invoiceId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const formData = new FormData()
          formData.set("invoiceId", invoiceId)
          const result = await retryEInvoiceSubmissionAction({}, formData)
          if (result.error) {
            toast.error(result.error)
          } else {
            toast.success("Submission retried.")
            router.refresh()
          }
        })
      }
    >
      <RotateCcw className="size-3.5" /> {pending ? "Retrying..." : "Retry"}
    </Button>
  )
}
