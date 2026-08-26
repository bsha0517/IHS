import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { PortalLoginForm } from "@/app/portal/login/login-form"

export default function PortalLoginPage() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Patient Portal</CardTitle>
          <CardDescription>Sign in to view your appointments, results, and invoices.</CardDescription>
        </CardHeader>
        <CardContent>
          <PortalLoginForm />
        </CardContent>
      </Card>
    </div>
  )
}
