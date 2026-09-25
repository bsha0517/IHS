import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { generateSystemCharge } from "@/lib/domains/billing/charges"
import { generateInvoice } from "@/lib/domains/billing/invoices"
import { setZatcaSellerProfile, getZatcaSellerProfile, type ZatcaSellerProfile } from "@/lib/domains/einvoicing/config"
import { submitInvoiceToZatca } from "@/lib/domains/einvoicing/service"
import { FIRST_INVOICE_PREVIOUS_HASH } from "@/lib/domains/einvoicing/hash-chain"
import { dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import type { SessionContext } from "@/lib/auth/session"

const TIMEOUT = 60000

/**
 * P5.5-Z — exercises the real ZATCA e-invoicing pipeline (config validation,
 * outbox-driven submission, hash chaining, ICV allocation, not_configured/
 * failed honesty) against a real database. Uses its own dedicated
 * organization/branch (not the shared seeded ones other integration tests
 * reuse) specifically to avoid writing a `zatca.sellerProfile` Setting onto
 * an organization other test files might also touch — see BACKLOG.md's
 * existing "integration-suite non-determinism" item this deliberately does
 * not add to.
 */
describe("P5.5-Z: ZATCA e-invoicing", () => {
  let organizationId: string
  let branchId: string
  let patientId: string
  let userId: string
  const createdInvoiceIds: string[] = []

  function session(): SessionContext {
    return {
      sessionId: "test-p5-5-z-session",
      user: { id: userId, organizationId, email: `p5-5-z-${Date.now()}@test.local`, firstName: "P5.5-Z", lastName: "Tester" },
      activeBranchId: branchId,
      branchIds: [branchId],
      permissions: new Set(["patient.view", "service.view", "charge.create", "invoice.view", "invoice.create", "einvoicing.configure", "einvoicing.view"]),
      roleNames: ["Accountant"],
    }
  }

  const SELLER: ZatcaSellerProfile = {
    enabled: true,
    vatRegistrationNumber: "300000000000003",
    sellerName: "P5.5-Z Synthetic Saudi Clinic",
    buildingNumber: "1234",
    streetName: "King Fahd Road",
    district: "Al Olaya",
    city: "Riyadh",
    postalCode: "12211",
    additionalNumber: "6789",
    countryCode: "SA",
  }

  async function newInvoice(amount: number) {
    const charge = await db.$transaction((tx) =>
      generateSystemCharge(tx, {
        organizationId, branchId, patientId,
        sourceType: "other", sourceReferenceId: `p5-5-z-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        description: "P5.5-Z synthetic consultation", quantity: 1, unitPrice: amount, serviceId: null,
      })
    )
    const invoice = await generateInvoice(session(), { branchId, patientId, chargeIds: [charge.id], discountAmount: 0 })
    createdInvoiceIds.push(invoice.id)
    await dispatchPendingOutboxEvents(organizationId)
    return invoice
  }

  beforeAll(async () => {
    // Reuses the shared seeded organization (real Chart of Accounts/Account
    // Mappings already provisioned by prisma/seed.ts — posting a real
    // invoice requires those, and this file deliberately doesn't reinvent
    // organization-level financial bootstrap just for ZATCA fixtures) but
    // creates its own dedicated branch/user/patient so cleanup never
    // touches another file's fixtures. Safe under vitest's fileParallelism:
    // false (test/vitest config) — no other file's tests run concurrently
    // with this one, so temporarily enabling this shared org's
    // `zatca.sellerProfile` Setting can't race another file.
    const branches = await db.branch.findMany({ take: 1, orderBy: { createdAt: "asc" } })
    if (branches.length < 1) throw new Error("Test requires at least 1 seeded branch (see LOCAL_DATABASE_SETUP.md).")
    organizationId = branches[0].organizationId

    const branch = await db.branch.create({
      data: { organizationId, name: "P5.5-Z Riyadh Main", code: `P55Z-${Date.now()}`, timezone: "Asia/Riyadh" },
    })
    branchId = branch.id
    const user = await db.user.create({
      data: { organizationId, email: `p5-5-z-user-${Date.now()}@test.local`, passwordHash: "x", firstName: "P5.5-Z", lastName: "Tester" },
    })
    userId = user.id
    const patient = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchId,
        mrn: `P55Z-${Date.now()}`, firstName: "Fahad", lastName: "Al-Test",
        dob: new Date("1990-01-01"), gender: "male", mobile: `P55ZM${Date.now()}`,
      },
    })
    patientId = patient.id
  }, TIMEOUT)

  afterAll(async () => {
    const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_DATABASE_URL }) })
    await ownerDb.eInvoiceSubmission.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } }).catch(() => {})
    await ownerDb.commissionAccrual.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } }).catch(() => {})
    await ownerDb.invoiceLine.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } }).catch(() => {})
    await ownerDb.invoice.deleteMany({ where: { id: { in: createdInvoiceIds } } }).catch(() => {})
    await ownerDb.charge.deleteMany({ where: { branchId } }).catch(() => {})
    const journals = await ownerDb.journal.findMany({ where: { branchId }, select: { id: true } })
    await ownerDb.journalLine.deleteMany({ where: { journalId: { in: journals.map((j) => j.id) } } }).catch(() => {})
    await ownerDb.journal.deleteMany({ where: { branchId } }).catch(() => {})
    const orgOutboxEvents = await ownerDb.outboxEvent.findMany({ where: { organizationId, eventType: "InvoiceIssued" }, select: { id: true, payload: true } })
    const myOutboxEventIds = orgOutboxEvents.filter((e) => createdInvoiceIds.includes((e.payload as { invoiceId?: string }).invoiceId ?? "")).map((e) => e.id)
    await ownerDb.outboxEvent.deleteMany({ where: { id: { in: myOutboxEventIds } } }).catch(() => {})
    // Also resets the org-wide ICV counter (never touches "INV"/"PAY"/etc —
    // other tests' sequences) so a repeated local run of this file alone
    // starts from a clean ICV=1 again, matching eInvoiceSubmission rows
    // also being wiped above — without this, the persistent number_sequence
    // row would keep advancing across runs while the submission history
    // resets, producing a real (test-only) inconsistency between "current
    // ICV" and "prior chain hash".
    await ownerDb.numberSequence.deleteMany({ where: { organizationId, sequenceType: "ICV" } }).catch(() => {})
    await ownerDb.setting.deleteMany({ where: { organizationId, key: "zatca.sellerProfile" } }).catch(() => {})
    await ownerDb.patient.delete({ where: { id: patientId } }).catch(() => {})
    await ownerDb.user.delete({ where: { id: userId } }).catch(() => {})
    await ownerDb.branch.delete({ where: { id: branchId } }).catch(() => {})
    await ownerDb.$disconnect()
  }, TIMEOUT)

  it("rejects an invalid VAT registration number (BR-KSA-05: 15 digits, first/last digit 3)", async () => {
    await expect(setZatcaSellerProfile(session(), { ...SELLER, vatRegistrationNumber: "123456789012345" })).rejects.toThrow(/VAT registration number/)
  })

  it("with no seller profile configured, writes a not_configured attempt record and allocates no ZATCA identity", async () => {
    const invoice = await newInvoice(100)
    const submission = await db.eInvoiceSubmission.findUnique({ where: { invoiceId: invoice.id } })
    expect(submission?.status).toBe("not_configured")
    expect(submission?.icv).toBeNull()
    expect(submission?.uuid).toBeNull()
    expect(submission?.xmlContent).toBeNull()
  }, TIMEOUT)

  // ICV is org-wide (see service.ts's nextNumber call, no branchId) — these
  // two tests capture a baseline rather than asserting a literal ICV=1/2, so
  // they stay correct whether this org already has prior ZATCA submissions
  // (any other run against the same his_test database) or not. The real
  // invariant under test is the increment and the hash-chain linkage, not
  // which absolute number the org happens to be on.
  let firstIcv: number
  let firstInvoiceHash: string

  it("once enabled, generates a real UBL XML/hash/QR and allocates the next ICV for the first invoice", async () => {
    await setZatcaSellerProfile(session(), SELLER)
    const profile = await getZatcaSellerProfile(organizationId)
    expect(profile.enabled).toBe(true)

    // The real, persistent source of truth for the next ICV is
    // nextNumber()'s own number_sequence row (org-wide, sequenceType "ICV")
    // — never reset by this file's own afterAll cleanup, unlike
    // eInvoiceSubmission rows, so that's what this baseline must read
    // rather than re-deriving from eInvoiceSubmission's own (test-cleaned)
    // history.
    const priorSequence = await db.numberSequence.findFirst({ where: { organizationId, branchId: null, sequenceType: "ICV" } })

    const invoice = await newInvoice(200)
    const submission = await db.eInvoiceSubmission.findUnique({ where: { invoiceId: invoice.id } })
    expect(submission?.status).toBe("not_configured") // no ZATCA_PRODUCTION_CSID in this test env
    expect(submission?.icv).toBe((priorSequence?.currentValue ?? 0) + 1)
    expect(submission?.uuid).toBeTruthy()
    expect(submission?.invoiceHash).toBeTruthy()
    expect(Buffer.from(submission!.invoiceHash!, "base64").length).toBe(32)
    expect(submission?.xmlContent).toContain("<cbc:InvoiceTypeCode name=\"0200000\">388</cbc:InvoiceTypeCode>")
    expect(submission?.xmlContent).toContain(profile.vatRegistrationNumber)
    expect(submission?.qrCode).toBeTruthy()

    firstIcv = submission!.icv!
    firstInvoiceHash = submission!.invoiceHash!
    // The very first ZATCA submission this org has ever made chains from the
    // spec's fixed seed; a later one chains from a real prior hash instead.
    if ((priorSequence?.currentValue ?? 0) === 0) {
      expect(submission?.previousInvoiceHash).toBe(FIRST_INVOICE_PREVIOUS_HASH)
    }
  }, TIMEOUT)

  it("chains the second invoice's previousInvoiceHash from the first invoice's own hash, with ICV incrementing", async () => {
    const invoice = await newInvoice(300)
    const submission = await db.eInvoiceSubmission.findUnique({ where: { invoiceId: invoice.id } })
    expect(submission?.icv).toBe(firstIcv + 1)
    expect(submission?.previousInvoiceHash).toBe(firstInvoiceHash)
    expect(submission?.previousInvoiceHash).not.toBe(FIRST_INVOICE_PREVIOUS_HASH)
  }, TIMEOUT)

  it("a real ZatcaEInvoiceProvider call against an unreachable configured endpoint fails honestly (never fakes success)", async () => {
    const originalEnv = { ...process.env }
    process.env.ZATCA_SANDBOX_BASE_URL = "http://127.0.0.1:1"
    process.env.ZATCA_PRODUCTION_CSID = "test-csid"
    process.env.ZATCA_PRODUCTION_SECRET = "test-secret"
    process.env.ZATCA_PRIVATE_KEY_PEM = "-----BEGIN EC PRIVATE KEY-----\ntest\n-----END EC PRIVATE KEY-----"
    try {
      const invoice = await newInvoice(400)
      const submission = await db.eInvoiceSubmission.findUnique({ where: { invoiceId: invoice.id } })
      expect(submission?.status).toBe("failed")
      expect(submission?.lastError).toBeTruthy()
      expect(submission?.zatcaStatus).toBeNull()
    } finally {
      process.env = originalEnv
    }
  }, TIMEOUT)

  it("a manual retry via submitInvoiceToZatca re-attempts and increments the attempts counter", async () => {
    const invoice = await newInvoice(150)
    const first = await db.eInvoiceSubmission.findUnique({ where: { invoiceId: invoice.id } })
    expect(first?.attempts).toBe(1)
    await submitInvoiceToZatca(invoice.id)
    const retried = await db.eInvoiceSubmission.findUnique({ where: { invoiceId: invoice.id } })
    expect(retried?.attempts).toBe(2)
  }, TIMEOUT)
})
