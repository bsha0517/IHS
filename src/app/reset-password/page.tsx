import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { RequestResetForm } from "@/app/reset-password/request-form"
import { ConfirmResetForm } from "@/app/reset-password/confirm-form"

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams

  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{token ? "Choose a new password" : "Reset your password"}</CardTitle>
          <CardDescription>
            {token
              ? "Enter a new password for your account."
              : "Enter the email address for your account."}
          </CardDescription>
        </CardHeader>
        <CardContent>{token ? <ConfirmResetForm token={token} /> : <RequestResetForm />}</CardContent>
      </Card>
    </div>
  )
}
