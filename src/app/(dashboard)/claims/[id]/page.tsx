import Link from "next/link"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { getClaim } from "@/lib/domains/claims/service"
import { formatDate, formatDateTime } from "@/lib/utils/dates"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { SubmitButton, ResubmitButton } from "@/app/(dashboard)/claims/[id]/claim-actions"
import { AdjudicateDialog } from "@/app/(dashboard)/claims/[id]/adjudicate-dialog"
import { RemittanceDialog } from "@/app/(dashboard)/claims/[id]/remittance-dialog"

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  draft: "outline",
  submitted: "secondary",
  adjudicated: "secondary",
  rejected: "destructive",
  remitted: "default",
  void: "destructive",
}

export default async function ClaimDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession()
  if (!session || !can(session, "claim.create")) redirect("/dashboard")

  const { id } = await params
  const canAdjudicate = can(session, "claim.adjudicate")
  const claim = await getClaim(session, id)

  const itemRows = claim.items.map((i) => ({
    id: i.id,
    description: i.invoiceLine.description,
    submittedAmount: Number(i.submittedAmount),
  }))

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{claim.claimNumber}</h1>
          <p className="text-sm text-muted-foreground">
            {claim.patient.firstName} {claim.patient.lastName} ({claim.patient.mrn}) · {claim.payor.name}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={STATUS_VARIANT[claim.status] ?? "outline"}>{claim.status}</Badge>
          {claim.status === "draft" && can(session, "claim.create") && <SubmitButton claimId={claim.id} />}
          {claim.status === "submitted" && canAdjudicate && <AdjudicateDialog claimId={claim.id} items={itemRows} />}
          {claim.status === "adjudicated" && canAdjudicate && (
            <RemittanceDialog claimId={claim.id} approvedAmount={Number(claim.approvedAmount ?? 0)} />
          )}
          {claim.status === "rejected" && !claim.resubmittedBy && can(session, "claim.create") && <ResubmitButton claimId={claim.id} />}
        </div>
      </div>

      {claim.resubmissionOf && (
        <p className="text-sm text-muted-foreground">
          Resubmission of{" "}
          <Link href={`/claims/${claim.resubmissionOf.id}`} className="hover:underline">
            {claim.resubmissionOf.claimNumber}
          </Link>
        </p>
      )}
      {claim.resubmittedBy && (
        <p className="text-sm text-muted-foreground">
          Resubmitted as{" "}
          <Link href={`/claims/${claim.resubmittedBy.id}`} className="hover:underline">
            {claim.resubmittedBy.claimNumber}
          </Link>
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1.5 text-sm">
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Invoice</span>
            <Link href={`/invoices/${claim.invoice.id}`} className="hover:underline">
              {claim.invoice.invoiceNumber}
            </Link>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Submitted amount</span>
            <span>{Number(claim.submittedAmount).toFixed(2)}</span>
          </div>
          {claim.approvedAmount != null && (
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Approved amount</span>
              <span>{Number(claim.approvedAmount).toFixed(2)}</span>
            </div>
          )}
          {claim.rejectedAmount != null && (
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Rejected amount</span>
              <span>{Number(claim.rejectedAmount).toFixed(2)}</span>
            </div>
          )}
          {claim.patientResponsibilityAmount != null && (
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Patient responsibility</span>
              <span>{Number(claim.patientResponsibilityAmount).toFixed(2)}</span>
            </div>
          )}
          {claim.rejectionReason && (
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Rejection reason</span>
              <span>{claim.rejectionReason}</span>
            </div>
          )}
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Submitted</span>
            <span>{claim.submittedAt ? formatDateTime(claim.submittedAt) : "—"}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Adjudicated</span>
            <span>{claim.adjudicatedAt ? formatDateTime(claim.adjudicatedAt) : "—"}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Remitted</span>
            <span>{claim.remittedAt ? formatDateTime(claim.remittedAt) : "—"}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Claim items</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Line</TableHead>
                <TableHead>Diagnosis</TableHead>
                <TableHead>Procedure code</TableHead>
                <TableHead className="text-right">Submitted</TableHead>
                <TableHead className="text-right">Approved</TableHead>
                <TableHead className="text-right">Rejected</TableHead>
                <TableHead>Denial reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {claim.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-medium">{item.invoiceLine.description}</TableCell>
                  <TableCell>{item.diagnosis?.description ?? "—"}</TableCell>
                  <TableCell>{item.procedureCode ?? "—"}</TableCell>
                  <TableCell className="text-right">{Number(item.submittedAmount).toFixed(2)}</TableCell>
                  <TableCell className="text-right">{item.approvedAmount != null ? Number(item.approvedAmount).toFixed(2) : "—"}</TableCell>
                  <TableCell className="text-right">{item.rejectedAmount != null ? Number(item.rejectedAmount).toFixed(2) : "—"}</TableCell>
                  <TableCell>{item.denialReason ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {claim.payments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Remittances</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Receipt #</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Received</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {claim.payments.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>{p.receiptNumber}</TableCell>
                    <TableCell className="text-right">{Number(p.amount).toFixed(2)}</TableCell>
                    <TableCell>{p.reference ?? "—"}</TableCell>
                    <TableCell>{formatDate(p.receivedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
