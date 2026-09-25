import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { db } from "@/lib/db"
import { getZatcaSellerProfile } from "@/lib/domains/einvoicing/config"
import { getZatcaCredentials, hasProductionCredentials, hasSigningKey } from "@/lib/domains/einvoicing/env"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { PageHeader } from "@/components/ui/page-header"
import { SellerProfileForm } from "@/app/(dashboard)/einvoicing/seller-profile-form"
import { EInvoiceRetryButton } from "@/app/(dashboard)/einvoicing/retry-button"

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  reported: "default",
  cleared: "default",
  pending: "secondary",
  not_configured: "outline",
  rejected: "destructive",
  failed: "destructive",
}

export default async function EInvoicingPage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "einvoicing.view")) {
    redirect("/dashboard")
  }

  const canConfigure = can(session, "einvoicing.configure")
  const canSubmit = can(session, "einvoicing.submit")

  const [sellerProfile, submissions] = await Promise.all([
    getZatcaSellerProfile(session.user.organizationId),
    db.eInvoiceSubmission.findMany({
      where: { organizationId: session.user.organizationId },
      include: { invoice: { select: { invoiceNumber: true } } },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ])

  const credentials = getZatcaCredentials()
  const productionReady = hasProductionCredentials(credentials)
  const signingReady = hasSigningKey(credentials)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="ZATCA e-Invoicing" module="finance" />

      {!productionReady || !signingReady ? (
        <Alert>
          <AlertTitle>Sandbox credentials not configured</AlertTitle>
          <AlertDescription>
            {!productionReady && "ZATCA_SANDBOX_BASE_URL / ZATCA_PRODUCTION_CSID / ZATCA_PRODUCTION_SECRET are not set. "}
            {!signingReady && "ZATCA_PRIVATE_KEY_PEM is not set. "}
            Invoices will still generate a UBL XML, hash, and partial QR code for review, but nothing is submitted to ZATCA until
            real sandbox credentials are provided — see docs/P5_5_Z_ZATCA_SANDBOX.md.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Seller profile</CardTitle>
          <CardDescription>
            Required national-address and VAT registration data for every Simplified Tax Invoice this organization issues.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SellerProfileForm profile={sellerProfile} canEdit={canConfigure} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent submissions</CardTitle>
          <CardDescription>One row per invoice issued since e-invoicing was configured.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead>ICV</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>ZATCA status</TableHead>
                <TableHead>Last attempt</TableHead>
                <TableHead>Attempts</TableHead>
                {canSubmit && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {submissions.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>{s.invoice.invoiceNumber}</TableCell>
                  <TableCell>{s.icv ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[s.status] ?? "outline"}>{s.status}</Badge>
                  </TableCell>
                  <TableCell>{s.zatcaStatus ?? "—"}</TableCell>
                  <TableCell>{s.lastAttemptAt ? s.lastAttemptAt.toLocaleString() : "—"}</TableCell>
                  <TableCell>{s.attempts}</TableCell>
                  {canSubmit && (
                    <TableCell>
                      {(s.status === "failed" || s.status === "rejected" || s.status === "not_configured") && (
                        <EInvoiceRetryButton invoiceId={s.invoiceId} />
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
              {submissions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={canSubmit ? 7 : 6} className="text-center text-muted-foreground">
                    No invoices have been issued since e-invoicing was configured.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
