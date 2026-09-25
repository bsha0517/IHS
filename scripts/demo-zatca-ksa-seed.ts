// P5.5-Z Phase 26 — a synthetic Saudi demo organization for exercising the
// ZATCA e-invoicing pipeline end to end. Entirely synthetic data (fictional
// clinic name, a placeholder-format VAT number, a fictional patient) — no
// real PHI, no real Saudi taxpayer data, per this phase's own explicit data-
// safety rule. Idempotent (checked by a stable display name before
// creating anything), safe to re-run.
//
// Uses only direct `db.*` Prisma calls — not the server-only-guarded
// service-layer functions (billing/invoices.ts, einvoicing/config.ts, etc.)
// — because this script runs via plain `tsx`, the same reason
// prisma/seed.ts and prisma/test-seed-extra.ts do the same. After running
// this, issue a demo invoice through the real running app (POS module, the
// synthetic patient this script creates) to see the actual outbox-driven
// ZATCA submission pipeline run — that path is what's actually exercised in
// production, and it's already covered by
// test/integration/p5-5-z-zatca-einvoicing.test.ts.
//
// Run: npx tsx scripts/demo-zatca-ksa-seed.ts   (against DATABASE_URL/
// DIRECT_DATABASE_URL — defaults to local `his_dev`, never run this against
// a production connection string).

import "dotenv/config"
import { db } from "../src/lib/db"
import { hashPassword } from "../src/lib/auth/password"
import { bootstrapSystemRoles } from "../src/lib/domains/identity/system-roles"

const DEMO_PASSWORD = "ZatcaDemo123!"

const ORG_DISPLAY_NAME = "P5.5-Z ZATCA Demo Clinic (Riyadh)"
const ADMIN_EMAIL = "zatca-demo-admin@avant.local"
const PATIENT_MRN_PREFIX = "ZATCA-DEMO"

const ZATCA_SELLER_PROFILE = {
  enabled: true,
  // Synthetic — conforms to the 15-digit/first-last-digit-3 format
  // (BR-KSA-05) but is not a real ZATCA-issued VAT registration number.
  vatRegistrationNumber: "300000000000003",
  sellerName: "P5.5-Z ZATCA Demo Clinic LLC (Synthetic)",
  buildingNumber: "7000",
  streetName: "Olaya Street",
  district: "Al Olaya",
  city: "Riyadh",
  postalCode: "12213",
  additionalNumber: "9999",
  countryCode: "SA",
}

async function main() {
  const existing = await db.organization.findFirst({ where: { displayName: ORG_DISPLAY_NAME } })
  if (existing) {
    console.log(`Demo org already exists (${existing.id}) — nothing to do. Re-run scripts/demo-zatca-ksa-seed.ts after a db:dev:setup reset if you need a fresh one.`)
    return
  }

  const org = await db.organization.create({
    data: { legalName: "P5.5-Z ZATCA Demo Clinic LLC", displayName: ORG_DISPLAY_NAME, defaultCurrency: "SAR", defaultTimezone: "Asia/Riyadh" },
  })
  const branch = await db.branch.create({
    data: { organizationId: org.id, name: "Riyadh Main", code: "ZATCA-RYD", timezone: "Asia/Riyadh" },
  })
  console.log(`Created organization ${org.id} / branch ${branch.id}`)

  // Minimal Chart of Accounts + Account Mappings — only the three
  // PostingIntents postInvoiceIssued() actually needs (posting-service.ts).
  // See prisma/seed.ts's own DEFAULT_ACCOUNTS/DEFAULT_MAPPINGS for the full
  // real-deployment set this intentionally does not duplicate in full.
  const accounts = await Promise.all([
    db.chartOfAccount.create({ data: { organizationId: org.id, code: "1100", name: "Accounts Receivable", type: "asset" } }),
    db.chartOfAccount.create({ data: { organizationId: org.id, code: "4000", name: "Service Revenue", type: "revenue" } }),
    db.chartOfAccount.create({ data: { organizationId: org.id, code: "2100", name: "Tax Payable", type: "liability" } }),
  ])
  const accountByCode = new Map(accounts.map((a) => [a.code, a.id]))
  await Promise.all([
    db.accountMapping.create({ data: { organizationId: org.id, intent: "accounts_receivable", accountId: accountByCode.get("1100")! } }),
    db.accountMapping.create({ data: { organizationId: org.id, intent: "revenue", accountId: accountByCode.get("4000")! } }),
    db.accountMapping.create({ data: { organizationId: org.id, intent: "tax_payable", accountId: accountByCode.get("2100")! } }),
  ])
  console.log("Created Chart of Accounts + Account Mappings")

  await bootstrapSystemRoles(db, org.id)
  const superAdminRole = await db.role.findFirstOrThrow({ where: { organizationId: org.id, name: "Super Admin" } })
  const admin = await db.user.create({
    data: { organizationId: org.id, email: ADMIN_EMAIL, passwordHash: await hashPassword(DEMO_PASSWORD), firstName: "ZATCA", lastName: "Demo Admin" },
  })
  await db.userRole.create({ data: { userId: admin.id, roleId: superAdminRole.id } })
  await db.userBranchAccess.create({ data: { userId: admin.id, branchId: branch.id } })
  console.log(`Created admin user ${admin.email} / ${DEMO_PASSWORD} (local dev only — never reuse this password anywhere real)`)

  const patient = await db.patient.create({
    data: {
      organizationId: org.id, registrationBranchId: branch.id,
      mrn: `${PATIENT_MRN_PREFIX}-001`, firstName: "Fahad", lastName: "Al-Demo",
      dob: new Date("1988-05-12"), gender: "male", mobile: "0500000001", nationality: "Saudi Arabia",
      addressLine: "Synthetic address — not a real patient", city: "Riyadh", country: "SA",
    },
  })
  console.log(`Created synthetic patient ${patient.firstName} ${patient.lastName} (${patient.mrn})`)

  const service = await db.service.create({
    data: {
      organizationId: org.id, name: "General Consultation (ZATCA demo)", code: "ZATCA-DEMO-CONSULT",
      category: "consultation", durationMinutes: 30, price: 100,
    },
  })
  console.log(`Created demo service ${service.name} (${service.id})`)

  await db.setting.create({
    data: { organizationId: org.id, branchId: null, key: "zatca.sellerProfile", value: ZATCA_SELLER_PROFILE as never },
  })
  console.log("Enabled ZATCA e-invoicing with a synthetic seller profile")

  console.log("\nDemo organization ready.")
  console.log(`  Organization: ${org.displayName} (${org.id})`)
  console.log(`  Branch: ${branch.name} (${branch.id})`)
  console.log(`  Patient: ${patient.firstName} ${patient.lastName}, MRN ${patient.mrn} (${patient.id})`)
  console.log(`  Service: ${service.name} (${service.id})`)
  console.log("\nNext: sign in as this org's Organization Administrator (create one via the app, or use platform-operator tooling), add a charge for the patient against this service, and issue an invoice through POS — the ZATCA submission record will appear at /einvoicing.")
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
