import "dotenv/config"
import { db } from "../src/lib/db"
import { hashPassword } from "../src/lib/auth/password"
import { generateRawToken } from "../src/lib/auth/tokens"
import { bootstrapSystemRoles } from "../src/lib/domains/identity/system-roles"
import type { $Enums } from "../src/generated/prisma/client"

// Permission catalog: capability-based, resource.action (spec.md §7). This is the
// full v1 catalog including permissions for domains that land in later phases —
// RBAC as a subsystem is Phase 1 scope even though the resources it protects
// (patients, invoices, ...) don't exist until those phases build them.
const PERMISSIONS: { code: string; category: string; description: string }[] = [
  // Administration / platform
  { code: "settings.view", category: "administration", description: "View organization settings" },
  { code: "settings.edit", category: "administration", description: "Edit organization settings" },
  { code: "branch.view", category: "administration", description: "View branches" },
  { code: "branch.manage", category: "administration", description: "Create/edit branches" },
  { code: "department.view", category: "administration", description: "View departments" },
  { code: "department.manage", category: "administration", description: "Create/edit departments" },
  { code: "room.view", category: "administration", description: "View rooms" },
  { code: "room.manage", category: "administration", description: "Create/edit rooms" },
  { code: "users.manage", category: "administration", description: "Manage users, roles, and permissions" },
  { code: "audit.review", category: "administration", description: "View audit log and clinical access log" },
  { code: "reports.export", category: "administration", description: "Export reports" },
  { code: "system_events.view", category: "administration", description: "View background system events (outbox) and their status" },
  { code: "system_events.retry", category: "administration", description: "Manually retry a failed or dead-lettered system event" },
  // P4.6 §46: a real, narrow permission for the onboarding/import workspace
  // — not folded into the broad `users.manage`/`settings.edit`, so a role
  // can be granted onboarding/import ability without also getting user
  // management or full settings edit, and vice versa.
  { code: "data_import.manage", category: "administration", description: "Run clinic onboarding data imports (patients, products, suppliers, services, opening inventory, ...)" },
  // P5.2 §7/§8: the clinic-side half of the support-ticket foundation — a
  // narrow permission, same reasoning as data_import.manage's own comment,
  // so it can be granted independently of full settings/user management.
  // Never grants access to another organization's tickets or to a
  // platform-internal note — those boundaries are enforced in
  // support-tickets.ts regardless of this permission (see that file's own
  // doc comment).
  { code: "support_ticket.manage", category: "administration", description: "View and create this organization's own support tickets, and read customer-visible replies" },

  // Practice management
  { code: "patient.view", category: "practice", description: "View patient records" },
  { code: "patient.create", category: "practice", description: "Register patients" },
  { code: "patient.edit", category: "practice", description: "Edit patient records" },
  { code: "provider.view", category: "practice", description: "View providers" },
  { code: "provider.manage", category: "practice", description: "Create/edit providers" },
  { code: "service.view", category: "practice", description: "View services" },
  { code: "service.manage", category: "practice", description: "Create/edit services" },
  { code: "appointment.view", category: "practice", description: "View appointments" },
  { code: "appointment.create", category: "practice", description: "Book appointments" },
  { code: "appointment.reschedule", category: "practice", description: "Reschedule appointments" },
  { code: "appointment.cancel", category: "practice", description: "Cancel appointments" },
  { code: "appointment.checkin", category: "practice", description: "Check in patients and manage the queue" },
  { code: "package.manage", category: "practice", description: "Create/edit the package master catalog" },
  { code: "package.sell", category: "practice", description: "Sell a package to a patient" },
  { code: "package.consume", category: "practice", description: "Record a patient package session as used" },

  // Clinical
  { code: "encounter.view", category: "clinical", description: "View encounters" },
  { code: "encounter.create", category: "clinical", description: "Open encounters" },
  { code: "encounter.finalize", category: "clinical", description: "Finalize encounters" },
  { code: "clinical_notes.view", category: "clinical", description: "View clinical notes" },
  { code: "clinical_notes.edit", category: "clinical", description: "Edit clinical notes (notes, diagnoses, follow-ups)" },
  { code: "vitals.record", category: "clinical", description: "Record patient vital signs" },
  { code: "prescription.create", category: "clinical", description: "Issue prescriptions" },
  { code: "prescription.verify", category: "clinical", description: "Pharmacist review of a dispensing record before it is dispensed" },
  { code: "prescription.dispense", category: "clinical", description: "Create and dispense pharmacy dispensing records" },
  { code: "lab_order.create", category: "clinical", description: "Place laboratory orders" },
  { code: "lab_result.enter", category: "clinical", description: "Enter laboratory results" },
  { code: "lab_result.verify", category: "clinical", description: "Verify laboratory results" },
  { code: "lab_test.manage", category: "clinical", description: "Manage the lab test/panel catalog" },
  { code: "imaging_order.perform", category: "clinical", description: "Assign, schedule, perform, and report on imaging orders" },
  { code: "imaging_result.verify", category: "clinical", description: "Verify a radiology report as the final result" },
  { code: "imaging_service.manage", category: "clinical", description: "Manage the imaging service catalog" },
  { code: "order.create", category: "clinical", description: "Place non-lab clinical orders (imaging, procedure, referral, other)" },

  // Revenue
  { code: "charge.create", category: "revenue", description: "Create ad-hoc charges at POS (procedure/product/other)" },
  { code: "charge.void", category: "revenue", description: "Void a pending charge" },
  { code: "invoice.view", category: "revenue", description: "View invoices" },
  { code: "invoice.create", category: "revenue", description: "Generate invoices from pending charges" },
  { code: "invoice.discount", category: "revenue", description: "Apply invoice discounts" },
  { code: "invoice.void", category: "revenue", description: "Void an unpaid invoice" },
  { code: "payment.view", category: "revenue", description: "View payments" },
  { code: "payment.create", category: "revenue", description: "Record payments" },
  { code: "refund.request", category: "revenue", description: "Request a refund" },
  { code: "refund.authorize", category: "revenue", description: "Authorize or reject a requested refund" },
  { code: "cashier.open", category: "revenue", description: "Open/close a cashier register session" },
  { code: "cashier.view", category: "revenue", description: "View all cashier sessions" },
  { code: "tax.manage", category: "revenue", description: "Configure tax rules" },

  // Payors & Insurance
  { code: "payor.manage", category: "insurance", description: "Manage the payor/insurance plan/policy catalog" },
  { code: "coverage.manage", category: "insurance", description: "Manage a patient's insurance coverage and prior authorizations" },
  { code: "claim.create", category: "insurance", description: "Create, submit, and resubmit insurance claims" },
  { code: "claim.adjudicate", category: "insurance", description: "Record claim adjudication and remittance" },

  // Patient Engagement
  { code: "communication.manage", category: "engagement", description: "Manage the communication template catalog" },
  { code: "communication.send", category: "engagement", description: "Send patient communications and view message history" },

  // Resources
  { code: "inventory.view", category: "resources", description: "View inventory" },
  { code: "inventory.adjust", category: "resources", description: "Adjust inventory / dispense" },
  { code: "product.manage", category: "resources", description: "Create/edit the product master catalog" },
  { code: "supplier.view", category: "resources", description: "View suppliers" },
  { code: "supplier.manage", category: "resources", description: "Create/edit suppliers" },
  { code: "purchase_request.create", category: "resources", description: "Create purchase requests" },
  { code: "purchase_request.approve", category: "resources", description: "Approve or reject purchase requests" },
  { code: "purchase_order.create", category: "resources", description: "Issue purchase orders" },
  { code: "goods_receipt.create", category: "resources", description: "Record goods receipts" },
  { code: "supplier_invoice.manage", category: "resources", description: "Record supplier invoices and payments" },
  { code: "stock.transfer", category: "resources", description: "Create and receive branch-to-branch stock transfers" },

  // Finance
  { code: "accounting.view", category: "finance", description: "View accounting records" },
  { code: "accounting.post", category: "finance", description: "Post manual journal entries" },
  { code: "accounting.period.manage", category: "finance", description: "Close and reopen accounting periods" },
  { code: "chart_of_account.manage", category: "finance", description: "Manage the chart of accounts" },
  { code: "account_mapping.manage", category: "finance", description: "Configure account mappings" },
  { code: "expense.create", category: "finance", description: "Record expenses" },

  // Workforce
  { code: "payroll.view", category: "workforce", description: "View payroll" },
  { code: "payroll.process", category: "workforce", description: "Process payroll" },
  { code: "employee.manage", category: "workforce", description: "Create/edit employee records" },
  { code: "attendance.record", category: "workforce", description: "Record employee check-in/check-out" },
  { code: "leave.request", category: "workforce", description: "Submit an employee leave request" },
  { code: "leave.approve", category: "workforce", description: "Approve or reject a leave request" },
  { code: "commission.manage", category: "workforce", description: "Configure provider commission rules" },
  { code: "commission.view", category: "workforce", description: "View provider commission accruals and statements" },
  { code: "asset.manage", category: "workforce", description: "Create/edit assets, maintenance, and calibration records" },
]

// SYSTEM_ROLES moved to src/lib/domains/identity/system-roles.ts (P5.1) so
// clinic provisioning (commercial/provisioning.ts) can bootstrap the exact
// same role/permission catalog for a newly created organization, from one
// definition instead of two that could drift apart.

// A small common-outpatient subset, not the full ICD-10 terminology hardcoded
// into the app (spec.md §24 / BLUEPRINT.md §43) — admins add more via the
// diagnosis code admin screen; a full bulk import is a later refinement.
const DIAGNOSIS_CODES: { code: string; description: string; category: string }[] = [
  { code: "J06.9", description: "Acute upper respiratory infection, unspecified", category: "Respiratory" },
  { code: "J20.9", description: "Acute bronchitis, unspecified", category: "Respiratory" },
  { code: "J45.909", description: "Unspecified asthma, uncomplicated", category: "Respiratory" },
  { code: "J02.9", description: "Acute pharyngitis, unspecified", category: "Respiratory" },
  { code: "E11.9", description: "Type 2 diabetes mellitus without complications", category: "Endocrine" },
  { code: "E78.5", description: "Hyperlipidemia, unspecified", category: "Endocrine" },
  { code: "E03.9", description: "Hypothyroidism, unspecified", category: "Endocrine" },
  { code: "I10", description: "Essential (primary) hypertension", category: "Cardiovascular" },
  { code: "I25.10", description: "Atherosclerotic heart disease without angina pectoris", category: "Cardiovascular" },
  { code: "R51", description: "Headache", category: "Neurological" },
  { code: "G43.909", description: "Migraine, unspecified, not intractable", category: "Neurological" },
  { code: "M54.5", description: "Low back pain", category: "Musculoskeletal" },
  { code: "M25.50", description: "Pain in unspecified joint", category: "Musculoskeletal" },
  { code: "M79.1", description: "Myalgia", category: "Musculoskeletal" },
  { code: "K21.9", description: "Gastro-esophageal reflux disease without esophagitis", category: "Digestive" },
  { code: "K59.00", description: "Constipation, unspecified", category: "Digestive" },
  { code: "A09", description: "Infectious gastroenteritis and colitis, unspecified", category: "Digestive" },
  { code: "R10.9", description: "Unspecified abdominal pain", category: "Digestive" },
  { code: "L20.9", description: "Atopic dermatitis, unspecified", category: "Dermatological" },
  { code: "L23.9", description: "Allergic contact dermatitis, unspecified cause", category: "Dermatological" },
  { code: "N39.0", description: "Urinary tract infection, site not specified", category: "Genitourinary" },
  { code: "H66.90", description: "Otitis media, unspecified, unspecified ear", category: "ENT" },
  { code: "H10.9", description: "Unspecified conjunctivitis", category: "Ophthalmological" },
  { code: "R50.9", description: "Fever, unspecified", category: "General" },
  { code: "R05", description: "Cough", category: "Respiratory" },
  { code: "R11.0", description: "Nausea", category: "Digestive" },
  { code: "F41.9", description: "Anxiety disorder, unspecified", category: "Mental Health" },
  { code: "F32.9", description: "Major depressive disorder, single episode, unspecified", category: "Mental Health" },
  { code: "Z00.00", description: "General adult medical examination without abnormal findings", category: "General" },
  { code: "Z23", description: "Encounter for immunization", category: "General" },
]

// A minimal, real chart of accounts — not exhaustive, but enough that every
// posting-service intent (see posting-service.ts's PostingIntent) resolves
// to a real account out of the box. An org can extend/rename these later;
// nothing in the posting service hardcodes an account by name, only by the
// `code` looked up here at seed time.
const DEFAULT_ACCOUNTS: { code: string; name: string; type: "asset" | "liability" | "equity" | "revenue" | "expense" }[] = [
  { code: "1000", name: "Cash", type: "asset" },
  { code: "1010", name: "Bank", type: "asset" },
  { code: "1100", name: "Accounts Receivable", type: "asset" },
  { code: "1200", name: "Inventory", type: "asset" },
  // P1 §15: recoverable purchase tax (e.g. input VAT) invoiced by a
  // supplier — an asset (a claim against future tax owed), not an expense.
  { code: "1300", name: "Recoverable Tax", type: "asset" },
  // P1 §17: capitalized asset purchases — separate from ordinary Inventory
  // (retail stock for resale) and Operating Expenses, so purchasing a piece
  // of equipment doesn't inflate either figure.
  { code: "1400", name: "Fixed Assets", type: "asset" },
  { code: "2000", name: "Accounts Payable", type: "liability" },
  // P1 §15: GR/IR clearing account — a provisional liability recognized at
  // physical goods-receipt time, before the supplier's actual invoice
  // (and its exact final amount) has arrived. Cleared to real Accounts
  // Payable when the supplier invoice is recorded. See GoodsReceipt's doc
  // comment (schema.prisma) and postGoodsReceiptCompleted /
  // postSupplierInvoiceCreated (posting-service.ts).
  { code: "2050", name: "Goods Received Not Invoiced", type: "liability" },
  { code: "2100", name: "Tax Payable", type: "liability" },
  { code: "2200", name: "Unearned Revenue", type: "liability" },
  { code: "2300", name: "Payroll Payable", type: "liability" },
  { code: "3000", name: "Owner's Equity", type: "equity" },
  { code: "4000", name: "Service Revenue", type: "revenue" },
  // P1 §13: the credit side of a stock-count gain (found more on hand than
  // the ledger recorded) — a non-operating gain, not ordinary service
  // revenue, kept in its own account so it's never blended into the
  // Service Revenue figure the P&L's main revenue line reads.
  { code: "4100", name: "Inventory Adjustment Gain", type: "revenue" },
  { code: "5000", name: "Operating Expenses", type: "expense" },
  // P1 §11: Cost of Goods Sold for retail product sales — the debit side of
  // postProductSaleCogs, separate from Operating Expenses so a P&L reader
  // can see gross margin (Revenue - COGS) before overhead.
  { code: "5100", name: "Cost of Goods Sold", type: "expense" },
  // P1 §13: damage/expiry/shrinkage write-offs — real inventory loss, kept
  // separate from both COGS (which represents inventory that was actually
  // sold) and Operating Expenses (general overhead).
  { code: "5200", name: "Inventory Write-off Expense", type: "expense" },
  { code: "6000", name: "Salary Expense", type: "expense" },
]

// intent -> account code. Org-wide default (branchId null); a branch can
// override any of these later via the Account Mappings admin screen.
// P2 §10: intent is now the real PostingIntent enum, not a bare string — a
// typo here (e.g. "acounts_payable") is now a compile-time error instead of
// a silently-broken seed row.
const DEFAULT_MAPPINGS: { intent: $Enums.PostingIntent; accountCode: string }[] = [
  { intent: "cash", accountCode: "1000" },
  { intent: "card", accountCode: "1010" },
  { intent: "bank", accountCode: "1010" },
  { intent: "online", accountCode: "1010" },
  // Phase 11 correction: the "insurance" tender previously mapped to the
  // same account (1100) as the "accounts_receivable" intent, which
  // postPaymentReceived() would post as Dr 1100 / Cr 1100 — a self-
  // canceling no-op that never showed a real cash inflow anywhere. Never
  // caught earlier because no payment had actually used the "insurance"
  // tender until Phase 11's recordRemittance() (Insurance was defined as a
  // payment method in Phase 4 but nothing exercised it until claims
  // existed). Mapped to Bank (1010), since a received remittance is real
  // money landing in the org's bank account.
  { intent: "insurance", accountCode: "1010" },
  // "credit" (a credit-card/store-credit tender) has the same 1100
  // collapse-to-AR issue and is NOT fixed here — Phase 11 doesn't exercise
  // it, so leaving it alone rather than fixing something untested this
  // phase (see PROJECT_STATUS.md's Phase 11 Known Issues).
  { intent: "credit", accountCode: "1100" },
  { intent: "other", accountCode: "1000" },
  { intent: "accounts_receivable", accountCode: "1100" },
  { intent: "revenue", accountCode: "4000" },
  { intent: "tax_payable", accountCode: "2100" },
  { intent: "unearned_revenue", accountCode: "2200" },
  { intent: "inventory_asset", accountCode: "1200" },
  { intent: "accounts_payable", accountCode: "2000" },
  { intent: "expense_default", accountCode: "5000" },
  // P1 §11/§13: product-sale COGS and inventory write-off/gain postings —
  // see posting-service.ts's postProductSaleCogs/postInventoryAdjustment.
  { intent: "cogs", accountCode: "5100" },
  { intent: "inventory_write_off", accountCode: "5200" },
  { intent: "inventory_adjustment_gain", accountCode: "4100" },
  { intent: "salary_expense", accountCode: "6000" },
  { intent: "payroll_payable", accountCode: "2300" },
  // P1 §15: GR/IR clearing (postGoodsReceiptCompleted's credit side) and
  // recoverable purchase tax (postSupplierInvoiceCreated's optional debit).
  { intent: "goods_received_not_invoiced", accountCode: "2050" },
  { intent: "recoverable_tax", accountCode: "1300" },
  // P1 §17: fixed-asset acquisitions — postAssetAcquired's debit side.
  { intent: "fixed_asset", accountCode: "1400" },
]

// A small common-outpatient subset, not the full LOINC/test-code universe
// hardcoded into the app (same reasoning as DIAGNOSIS_CODES above) — admins
// extend this via the Lab Test catalog admin screen. CBC's members are
// bundled into a panel below so ordering "CBC" produces five independent,
// individually-referenced-ranged results, matching a real CBC panel.
const DEFAULT_LAB_TESTS: {
  code: string
  name: string
  category: string
  specimenType: string
  resultType: "numeric" | "text"
  unit?: string
  referenceRangeLow?: number
  referenceRangeHigh?: number
  referenceRangeText?: string
  // P1 §22: standard clinical panic values, seeded on one representative
  // test (Glucose) as a real, working demonstration of the critical-flag
  // feature — not added everywhere, since most of this subset's real
  // critical thresholds vary by lab/population and shouldn't be guessed at.
  criticalLow?: number
  criticalHigh?: number
  price: number
}[] = [
  {
    code: "GLU", name: "Glucose, Fasting", category: "Chemistry", specimenType: "blood", resultType: "numeric", unit: "mg/dL",
    referenceRangeLow: 70, referenceRangeHigh: 100, criticalLow: 40, criticalHigh: 400, price: 40,
  },
  { code: "CREAT", name: "Creatinine", category: "Chemistry", specimenType: "blood", resultType: "numeric", unit: "mg/dL", referenceRangeLow: 0.6, referenceRangeHigh: 1.3, price: 45 },
  { code: "TSH", name: "TSH", category: "Endocrine", specimenType: "blood", resultType: "numeric", unit: "mIU/L", referenceRangeLow: 0.4, referenceRangeHigh: 4.0, price: 90 },
  { code: "URINE-RM", name: "Urine Routine & Microscopy", category: "Urinalysis", specimenType: "urine", resultType: "text", referenceRangeText: "No abnormal findings", price: 35 },
  { code: "WBC", name: "White Blood Cell Count", category: "Hematology", specimenType: "blood", resultType: "numeric", unit: "x10^9/L", referenceRangeLow: 4.0, referenceRangeHigh: 11.0, price: 25 },
  { code: "RBC", name: "Red Blood Cell Count", category: "Hematology", specimenType: "blood", resultType: "numeric", unit: "x10^12/L", referenceRangeLow: 4.2, referenceRangeHigh: 5.9, price: 25 },
  { code: "HGB", name: "Hemoglobin", category: "Hematology", specimenType: "blood", resultType: "numeric", unit: "g/dL", referenceRangeLow: 13.0, referenceRangeHigh: 17.0, price: 25 },
  { code: "HCT", name: "Hematocrit", category: "Hematology", specimenType: "blood", resultType: "numeric", unit: "%", referenceRangeLow: 38, referenceRangeHigh: 50, price: 25 },
  { code: "PLT", name: "Platelet Count", category: "Hematology", specimenType: "blood", resultType: "numeric", unit: "x10^9/L", referenceRangeLow: 150, referenceRangeHigh: 450, price: 25 },
]

const DEFAULT_LAB_PANELS: { code: string; name: string; price: number; testCodes: string[] }[] = [
  { code: "CBC", name: "Complete Blood Count", price: 100, testCodes: ["WBC", "RBC", "HGB", "HCT", "PLT"] },
]

const DEFAULT_IMAGING_SERVICES: {
  code: string
  name: string
  category: string
  bodyPart?: string
  price: number
  turnaroundHours?: number
}[] = [
  { code: "XR-CHEST", name: "Chest X-Ray", category: "X-Ray", bodyPart: "Chest", price: 80, turnaroundHours: 2 },
  { code: "XR-KNEE", name: "Knee X-Ray", category: "X-Ray", bodyPart: "Knee", price: 70, turnaroundHours: 2 },
  { code: "US-ABDOMEN", name: "Abdominal Ultrasound", category: "Ultrasound", bodyPart: "Abdomen", price: 150, turnaroundHours: 4 },
  { code: "CT-HEAD", name: "CT Head (non-contrast)", category: "CT", bodyPart: "Head", price: 400, turnaroundHours: 24 },
  { code: "MRI-KNEE", name: "MRI Knee", category: "MRI", bodyPart: "Knee", price: 650, turnaroundHours: 48 },
]

// The exact 8 templates spec.md §56 names, one channel (sms) each — admins
// can add more per key/channel later via the /communications catalog, the
// same "small real subset, admin-extendable" precedent as every other seed
// catalog. `{{variable}}` placeholders are resolved server-side by
// `renderTemplate()`, never client-submitted.
const DEFAULT_COMM_TEMPLATES: { key: string; name: string; body: string }[] = [
  { key: "appointment_confirmation", name: "Appointment Confirmation", body: "Hi {{patientName}}, your appointment with {{providerName}} at {{branchName}} is confirmed for {{appointmentDate}} at {{appointmentTime}}." },
  { key: "appointment_reminder", name: "Appointment Reminder", body: "Reminder: {{patientName}}, you have an appointment with {{providerName}} on {{appointmentDate}} at {{appointmentTime}}." },
  { key: "appointment_cancellation", name: "Appointment Cancellation", body: "Hi {{patientName}}, your appointment on {{appointmentDate}} at {{appointmentTime}} has been cancelled." },
  { key: "follow_up_reminder", name: "Follow-Up Reminder", body: "Hi {{patientName}}, a follow-up is recommended around {{followUpDate}}: {{reason}}." },
  { key: "payment_reminder", name: "Payment Reminder", body: "Hi {{patientName}}, invoice {{invoiceNumber}} has an outstanding balance of {{outstandingAmount}}." },
  { key: "package_expiry", name: "Package Expiry", body: "Hi {{patientName}}, your package \"{{packageName}}\" expires on {{expiryDate}}." },
  { key: "lab_result_ready", name: "Lab Result Ready", body: "Hi {{patientName}}, your result for {{testOrStudyName}} is ready. Please contact the clinic." },
  { key: "birthday", name: "Birthday Greeting", body: "Happy Birthday, {{patientName}}! Wishing you good health from all of us." },
]

async function main() {
  console.log("Seeding permission catalog...")
  for (const permission of PERMISSIONS) {
    await db.permission.upsert({
      where: { code: permission.code },
      update: { category: permission.category, description: permission.description },
      create: permission,
    })
  }

  console.log("Seeding diagnosis code subset...")
  for (const code of DIAGNOSIS_CODES) {
    await db.diagnosisCode.upsert({
      where: { code: code.code },
      update: { description: code.description, category: code.category },
      create: code,
    })
  }

  let organization = await db.organization.findFirst()
  if (!organization) {
    console.log("Creating default organization...")
    organization = await db.organization.create({
      data: {
        legalName: "Avant Health Clinic LLC",
        displayName: "Avant Health Clinic",
        defaultCurrency: "AED",
        defaultTimezone: "Asia/Dubai",
      },
    })
  }

  let branch = await db.branch.findFirst({ where: { organizationId: organization.id } })
  if (!branch) {
    console.log("Creating default branch...")
    branch = await db.branch.create({
      data: {
        organizationId: organization.id,
        name: "Main Branch",
        code: "MAIN",
        timezone: organization.defaultTimezone,
      },
    })
  }

  let department = await db.department.findFirst({ where: { branchId: branch.id } })
  if (!department) {
    department = await db.department.create({
      data: { branchId: branch.id, name: "General", code: "GEN" },
    })
  }

  const existingRoom = await db.room.findFirst({ where: { departmentId: department.id } })
  if (!existingRoom) {
    await db.room.create({
      data: { departmentId: department.id, name: "Room 1", code: "R1", roomType: "consultation" },
    })
  }

  console.log("Seeding default chart of accounts...")
  const accountByCode = new Map<string, string>()
  for (const account of DEFAULT_ACCOUNTS) {
    const created = await db.chartOfAccount.upsert({
      where: { organizationId_code: { organizationId: organization.id, code: account.code } },
      update: { name: account.name, type: account.type },
      create: { organizationId: organization.id, code: account.code, name: account.name, type: account.type },
    })
    accountByCode.set(account.code, created.id)
  }

  console.log("Seeding default account mappings...")
  for (const mapping of DEFAULT_MAPPINGS) {
    const accountId = accountByCode.get(mapping.accountCode)
    if (!accountId) continue
    const existingMapping = await db.accountMapping.findFirst({
      where: { organizationId: organization.id, branchId: null, intent: mapping.intent },
    })
    if (!existingMapping) {
      await db.accountMapping.create({
        data: { organizationId: organization.id, branchId: null, intent: mapping.intent, accountId },
      })
    }
  }

  console.log("Seeding default lab test catalog...")
  const labTestByCode = new Map<string, string>()
  for (const test of DEFAULT_LAB_TESTS) {
    const created = await db.labTest.upsert({
      where: { organizationId_code: { organizationId: organization.id, code: test.code } },
      update: {
        name: test.name,
        category: test.category,
        specimenType: test.specimenType,
        resultType: test.resultType,
        unit: test.unit ?? null,
        referenceRangeLow: test.referenceRangeLow ?? null,
        referenceRangeHigh: test.referenceRangeHigh ?? null,
        referenceRangeText: test.referenceRangeText ?? null,
        criticalLow: test.criticalLow ?? null,
        criticalHigh: test.criticalHigh ?? null,
        price: test.price,
      },
      create: {
        organizationId: organization.id,
        code: test.code,
        name: test.name,
        category: test.category,
        specimenType: test.specimenType,
        resultType: test.resultType,
        unit: test.unit ?? null,
        referenceRangeLow: test.referenceRangeLow ?? null,
        referenceRangeHigh: test.referenceRangeHigh ?? null,
        referenceRangeText: test.referenceRangeText ?? null,
        criticalLow: test.criticalLow ?? null,
        criticalHigh: test.criticalHigh ?? null,
        price: test.price,
      },
    })
    labTestByCode.set(test.code, created.id)
  }

  console.log("Seeding default lab panels...")
  for (const panel of DEFAULT_LAB_PANELS) {
    const created = await db.labPanel.upsert({
      where: { organizationId_code: { organizationId: organization.id, code: panel.code } },
      update: { name: panel.name, price: panel.price },
      create: { organizationId: organization.id, code: panel.code, name: panel.name, price: panel.price },
    })
    for (const testCode of panel.testCodes) {
      const labTestId = labTestByCode.get(testCode)
      if (!labTestId) continue
      await db.labPanelTest.upsert({
        where: { labPanelId_labTestId: { labPanelId: created.id, labTestId } },
        update: {},
        create: { labPanelId: created.id, labTestId },
      })
    }
  }

  console.log("Seeding default imaging service catalog...")
  for (const service of DEFAULT_IMAGING_SERVICES) {
    await db.imagingService.upsert({
      where: { organizationId_code: { organizationId: organization.id, code: service.code } },
      update: {
        name: service.name,
        category: service.category,
        bodyPart: service.bodyPart ?? null,
        price: service.price,
        turnaroundHours: service.turnaroundHours ?? null,
      },
      create: {
        organizationId: organization.id,
        code: service.code,
        name: service.name,
        category: service.category,
        bodyPart: service.bodyPart ?? null,
        price: service.price,
        turnaroundHours: service.turnaroundHours ?? null,
      },
    })
  }

  console.log("Seeding default communication templates...")
  for (const template of DEFAULT_COMM_TEMPLATES) {
    await db.commTemplate.upsert({
      where: { organizationId_key: { organizationId: organization.id, key: template.key } },
      update: { name: template.name, body: template.body },
      create: {
        organizationId: organization.id,
        key: template.key,
        channel: "sms",
        name: template.name,
        body: template.body,
      },
    })
  }

  console.log("Seeding system roles...")
  await bootstrapSystemRoles(db, organization.id)

  const superAdminRole = await db.role.findFirstOrThrow({
    where: { organizationId: organization.id, name: "Super Admin" },
  })

  const existingSuperAdmin = await db.user.findFirst({
    where: { organizationId: organization.id, email: "admin@avant.local" },
  })

  if (!existingSuperAdmin) {
    // P4.1 §32: this script is DEPLOYMENT.md's own documented production
    // bootstrap mechanism ("run npm run db:seed once, against the fresh
    // production database... to create... the initial Super Admin
    // account") — a hardcoded, well-known password here was a real
    // production risk, not just a local-dev convenience, since nothing
    // stopped this exact code path from being the one that actually
    // provisions a live deployment's first admin account. Local
    // development keeps the previous convenient, well-known password
    // (never a security boundary in dev); a real deployment either sets
    // SUPER_ADMIN_BOOTSTRAP_PASSWORD explicitly (e.g. injected from the
    // hosting platform's own secret manager) or gets a freshly generated
    // one printed exactly once, here, which must be captured immediately —
    // it is never stored anywhere and this script cannot show it again.
    const isProduction = process.env.NODE_ENV === "production"
    const bootstrapPassword = process.env.SUPER_ADMIN_BOOTSTRAP_PASSWORD ?? (isProduction ? generateRawToken() : "ChangeMe123!")
    if (isProduction && !process.env.SUPER_ADMIN_BOOTSTRAP_PASSWORD) {
      console.log(`\n${"=".repeat(70)}`)
      console.log(`Creating Super Admin user: admin@avant.local`)
      console.log(`Generated password (shown once — capture this now): ${bootstrapPassword}`)
      console.log(`${"=".repeat(70)}\n`)
    } else {
      console.log(`Creating Super Admin user (admin@avant.local / ${bootstrapPassword}) — change this password immediately.`)
    }
    const user = await db.user.create({
      data: {
        organizationId: organization.id,
        email: "admin@avant.local",
        firstName: "Super",
        lastName: "Admin",
        passwordHash: await hashPassword(bootstrapPassword),
      },
    })
    await db.userRole.create({ data: { userId: user.id, roleId: superAdminRole.id } })
    await db.userBranchAccess.create({ data: { userId: user.id, branchId: branch.id } })
  }

  // P5.1 §19/§59: the platform operator's own bootstrap — same "documented
  // production bootstrap mechanism" reasoning as the clinic Super Admin
  // above, against `PlatformOperator` instead of `User` (a completely
  // separate identity plane — see that model's own doc comment). This is
  // the ONLY place a PlatformOperator row is ever created outside the
  // platform's own (not-yet-built-in-V1) operator-management UI — there is
  // no self-service platform signup anywhere in this codebase.
  console.log("Seeding platform operator bootstrap account...")
  const existingOperator = await db.platformOperator.findFirst({ where: { email: "operator@avant.local" } })
  if (!existingOperator) {
    const isProduction = process.env.NODE_ENV === "production"
    const operatorBootstrapPassword = process.env.PLATFORM_OPERATOR_BOOTSTRAP_PASSWORD ?? (isProduction ? generateRawToken() : "ChangeMe123!")
    if (isProduction && !process.env.PLATFORM_OPERATOR_BOOTSTRAP_PASSWORD) {
      console.log(`\n${"=".repeat(70)}`)
      console.log(`Creating platform operator: operator@avant.local`)
      console.log(`Generated password (shown once — capture this now): ${operatorBootstrapPassword}`)
      console.log(`${"=".repeat(70)}\n`)
    } else {
      console.log(`Creating platform operator (operator@avant.local / ${operatorBootstrapPassword}) — change this password immediately.`)
    }
    await db.platformOperator.create({
      data: {
        email: "operator@avant.local",
        firstName: "Platform",
        lastName: "Operator",
        passwordHash: await hashPassword(operatorBootstrapPassword),
      },
    })
  }

  // P5.1 §9: seed examples only — an operator can add/edit plans from
  // `/platform/plans`. Not hard-coded into any application logic; these
  // three rows have no special meaning beyond being a reasonable starting
  // catalog for a first commercial customer.
  console.log("Seeding example commercial plans...")
  const CORE_MODULES = ["reception", "patients", "appointments", "clinical", "nursing"] as const
  const DEFAULT_PLANS: { code: string; name: string; description: string; userLimit: number | null; branchLimit: number | null; defaultModuleKeys: string[] }[] = [
    {
      code: "starter",
      name: "Starter",
      description: "Single-branch outpatient clinic — core clinical + billing, no inventory/finance/HR modules.",
      userLimit: 10,
      branchLimit: 1,
      defaultModuleKeys: [...CORE_MODULES, "pos_billing", "reports"],
    },
    {
      code: "professional",
      name: "Professional",
      description: "Multi-branch clinic with pharmacy, lab, imaging, inventory, and finance.",
      userLimit: 50,
      branchLimit: 5,
      defaultModuleKeys: [...CORE_MODULES, "laboratory", "radiology", "pharmacy", "pos_billing", "inventory", "procurement", "finance", "reports", "imports_onboarding"],
    },
    {
      code: "enterprise",
      name: "Enterprise",
      description: "Full module set, no user/branch limit.",
      userLimit: null,
      branchLimit: null,
      defaultModuleKeys: [...CORE_MODULES, "laboratory", "radiology", "pharmacy", "pos_billing", "inventory", "procurement", "finance", "hr", "payroll", "assets", "reports", "imports_onboarding"],
    },
  ]
  for (const plan of DEFAULT_PLANS) {
    await db.commercialPlan.upsert({
      where: { code: plan.code },
      update: {},
      create: plan,
    })
  }

  console.log("Seed complete.")
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
