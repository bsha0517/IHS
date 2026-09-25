import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { PlatformLoginForm } from "@/app/platform/login/login-form"

/**
 * P5.1 §20/§84: a fully separate login surface from `/login` (staff) and
 * `/portal/login` (patients) — see PlatformOperator's own doc comment. This
 * page intentionally sits OUTSIDE `platform/(shell)/layout.tsx`'s own
 * session check (a route group, not a URL segment) so it never redirect-
 * loops against itself the way wrapping it in the authenticated shell would.
 */
export default async function PlatformLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>
}) {
  const { from } = await searchParams

  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Avant Platform</CardTitle>
          <CardDescription>Operator sign-in — commercial control plane</CardDescription>
        </CardHeader>
        <CardContent>
          <PlatformLoginForm from={from} />
        </CardContent>
      </Card>
    </div>
  )
}
