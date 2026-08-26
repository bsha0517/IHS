"use client"

import { useEffect } from "react"
import { AlertTriangle } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

/**
 * Route-segment error boundary (Phase 14 hardening — this build had none
 * until now, so any unhandled Server Component exception fell through to
 * Next's default, unstyled error overlay). Deliberately does not show the
 * raw error message to the user — the same "never leak a raw DB/internal
 * error" discipline already applied to translateBookingError and every
 * Server Action's catch block; the real message goes to the server console
 * via `console.error`, which is what production log aggregation reads.
 */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Card className="max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-destructive" />
            <CardTitle>Something went wrong</CardTitle>
          </div>
          <CardDescription>
            An unexpected error occurred while loading this page. This has been logged.
            {error.digest && <span className="mt-1 block font-mono text-xs">Reference: {error.digest}</span>}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={reset}>Try again</Button>
        </CardContent>
      </Card>
    </div>
  )
}
