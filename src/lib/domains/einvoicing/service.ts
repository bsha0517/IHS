import "server-only"
import { randomUUID } from "node:crypto"
import { db } from "@/lib/db"
import type { Prisma } from "@/generated/prisma/client"
import { nextNumber } from "@/lib/platform/sequences"
import { writeAuditLog } from "@/lib/platform/audit"
import { getZatcaSellerProfile } from "@/lib/domains/einvoicing/config"
import { getZatcaCredentials, hasProductionCredentials, hasSigningKey } from "@/lib/domains/einvoicing/env"
import { NullEInvoiceProvider } from "@/lib/domains/einvoicing/adapters/null-provider"
import { ZatcaEInvoiceProvider } from "@/lib/domains/einvoicing/adapters/zatca-provider"
import type { EInvoiceProvider } from "@/lib/domains/einvoicing/adapters/types"
import { buildInvoiceXml, fillQrCode, type XmlInvoiceLine } from "@/lib/domains/einvoicing/xml-mapper"
import { computeInvoiceHash, FIRST_INVOICE_PREVIOUS_HASH } from "@/lib/domains/einvoicing/hash-chain"
import { buildPartialQrTlv } from "@/lib/domains/einvoicing/qr-code"

function resolveProvider(): EInvoiceProvider {
  const creds = getZatcaCredentials()
  if (hasProductionCredentials(creds) && hasSigningKey(creds)) return new ZatcaEInvoiceProvider(creds)
  return new NullEInvoiceProvider()
}

/**
 * Maps a TaxRule's rate to a ZATCA VAT category code (S/Z/E/O). This
 * codebase's TaxRule model has no classification field distinguishing
 * zero-rated, exempt, and out-of-scope supplies (schema.prisma's TaxRule —
 * see docs/P5_5_Z_ZATCA_SANDBOX.md's gap list) — only a rate. rate > 0 maps
 * to Standard ("S"); rate === 0 maps to Zero-rated ("Z"), the more common
 * real-world case for a 0% line in a KSA clinic (exports/certain medical
 * supplies) versus Exempt or genuinely out-of-scope, which this simplified
 * mapping cannot distinguish. A real production rollout needs a
 * classification field on TaxRule before Exempt/Out-of-scope lines can be
 * represented correctly.
 */
function vatCategoryForRate(ratePercent: number): "S" | "Z" {
  return ratePercent > 0 ? "S" : "Z"
}

/** Numeric part of a nextNumber()-formatted string like "ICV-000042" -> 42. */
function parseSequenceValue(formatted: string): number {
  const match = formatted.match(/(\d+)$/)
  if (!match) throw new Error(`Unexpected sequence format: ${formatted}`)
  return Number(match[1])
}

/**
 * Called from the InvoiceIssued outbox handler (event-handlers.ts), as an
 * additional handler alongside postInvoiceIssued/accrueInvoiceBasisCommissions
 * — the same seam the architecture-mapping research identified. Always
 * writes an EInvoiceSubmission row (the "attempt record, never fake
 * success" discipline from CommMessage) even when no ZATCA profile is
 * configured, so the org's e-invoicing status is visible and auditable
 * regardless of whether ZATCA is actually enabled — but a real ZATCA
 * identity (ICV/UUID/hash) is only ever allocated once a real submission
 * attempt is actually being built (see schema.prisma's EInvoiceSubmission
 * doc comment on why those fields are nullable).
 */
export async function submitInvoiceToZatca(invoiceId: string): Promise<void> {
  const invoice = await db.invoice.findUnique({
    where: { id: invoiceId },
    include: { lines: true, patient: true },
  })
  if (!invoice) return

  const sellerProfile = await getZatcaSellerProfile(invoice.organizationId)
  const existing = await db.eInvoiceSubmission.findUnique({ where: { invoiceId } })

  if (!sellerProfile.enabled) {
    await db.eInvoiceSubmission.upsert({
      where: { invoiceId },
      create: {
        organizationId: invoice.organizationId,
        invoiceId,
        status: "not_configured",
        attempts: 1,
        lastAttemptAt: new Date(),
        lastError: "ZATCA e-invoicing is not enabled for this organization.",
      },
      update: {
        status: "not_configured",
        attempts: { increment: 1 },
        lastAttemptAt: new Date(),
        lastError: "ZATCA e-invoicing is not enabled for this organization.",
      },
    })
    return
  }

  const previousSubmission = await db.eInvoiceSubmission.findFirst({
    where: { organizationId: invoice.organizationId, invoiceHash: { not: null } },
    orderBy: { icv: "desc" },
  })
  const previousInvoiceHash = previousSubmission?.invoiceHash ?? FIRST_INVOICE_PREVIOUS_HASH

  const icvValue = parseSequenceValue(
    await nextNumber({ organizationId: invoice.organizationId, sequenceType: "ICV", prefix: "ICV", padding: 1 })
  )
  const uuid = randomUUID()
  const issuedAt = invoice.issuedAt
  const issueDate = issuedAt.toISOString().slice(0, 10)
  const issueTime = issuedAt.toISOString().slice(11, 19)

  const lines: XmlInvoiceLine[] = invoice.lines.map((line, index) => {
    const lineNet = Number(line.unitPrice) * line.quantity - Number(line.discountAmount)
    const taxAmount = Number(line.taxAmount)
    const ratePercent = lineNet > 0 ? Math.round((taxAmount / lineNet) * 10000) / 100 : 0
    return {
      id: String(index + 1),
      description: line.description,
      quantity: line.quantity,
      unitPrice: Number(line.unitPrice).toFixed(2),
      lineNetAmount: lineNet.toFixed(2),
      taxPercent: ratePercent.toFixed(2),
      taxAmount: taxAmount.toFixed(2),
      taxCategoryCode: vatCategoryForRate(ratePercent),
    }
  })

  const xmlWithoutQr = buildInvoiceXml({
    invoiceNumber: invoice.invoiceNumber,
    uuid,
    icv: icvValue,
    issueDate,
    issueTime,
    invoiceTypeName: "0200000",
    previousInvoiceHash,
    seller: sellerProfile,
    buyerName: `${invoice.patient.firstName} ${invoice.patient.lastName}`.trim(),
    lines,
    lineExtensionAmount: Number(invoice.subtotal).toFixed(2),
    taxExclusiveAmount: (Number(invoice.subtotal) - Number(invoice.discountAmount)).toFixed(2),
    taxInclusiveAmount: Number(invoice.totalAmount).toFixed(2),
    taxAmount: Number(invoice.taxAmount).toFixed(2),
    payableAmount: Number(invoice.totalAmount).toFixed(2),
  })

  const invoiceHash = computeInvoiceHash(xmlWithoutQr)
  const qrCode = buildPartialQrTlv({
    sellerName: sellerProfile.sellerName,
    vatRegistrationNumber: sellerProfile.vatRegistrationNumber,
    invoiceTimestamp: `${issueDate}T${issueTime}Z`,
    invoiceTotalWithVat: Number(invoice.totalAmount).toFixed(2),
    vatTotal: Number(invoice.taxAmount).toFixed(2),
    invoiceHashBytes: Buffer.from(invoiceHash, "base64"),
  })
  const finalXml = fillQrCode(xmlWithoutQr, qrCode)

  const provider = resolveProvider()
  const result = await provider.submitInvoice({
    invoiceHash,
    uuid,
    xmlBase64: Buffer.from(finalXml, "utf8").toString("base64"),
  })

  const base = {
    organizationId: invoice.organizationId,
    invoiceId,
    invoiceTypeCode: "388",
    invoiceTypeName: "0200000",
    uuid,
    icv: icvValue,
    previousInvoiceHash,
    invoiceHash,
    qrCode,
    xmlContent: finalXml,
    attempts: (existing?.attempts ?? 0) + 1,
    lastAttemptAt: new Date(),
  }

  const statusFields =
    result.outcome === "reported" || result.outcome === "cleared"
      ? {
          status: result.outcome,
          zatcaStatus: result.zatcaStatus,
          warnings: result.warnings as Prisma.InputJsonValue,
          errors: result.errors as Prisma.InputJsonValue,
          submittedAt: new Date(),
          lastError: null,
        }
      : result.outcome === "rejected"
        ? {
            status: "rejected" as const,
            zatcaStatus: result.zatcaStatus,
            warnings: result.warnings as Prisma.InputJsonValue,
            errors: result.errors as Prisma.InputJsonValue,
            lastError: "ZATCA rejected the submission — see errors.",
          }
        : result.outcome === "not_configured"
          ? { status: "not_configured" as const, lastError: result.reason }
          : { status: "failed" as const, lastError: result.error }

  await db.eInvoiceSubmission.upsert({
    where: { invoiceId },
    create: { ...base, ...statusFields },
    update: { ...base, ...statusFields },
  })

  await writeAuditLog({
    organizationId: invoice.organizationId,
    userId: null,
    action: "create",
    entityType: "e_invoice_submission",
    entityId: invoiceId,
    newValues: { status: statusFields.status, icv: icvValue, uuid },
  })
}
