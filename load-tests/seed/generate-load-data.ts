// npx tsx load-tests/seed/generate-load-data.ts
//
// P4.5 §13/§14: bulk synthetic data generation for `his_load_test` — run
// AFTER `npm run db:load-test:setup` (which applies the same system/catalog
// baseline — permissions, roles, chart of accounts — every environment
// gets via prisma/seed.ts). This script adds volume on top of that
// baseline: patients, appointments, encounters, clinical orders, products/
// batches/stock ledger, invoices/charges/payments/journals, staff users,
// login history, and outbox history.
//
// HONEST SCOPE NOTE (documented in
// P4_5_PERFORMANCE_CONCURRENCY_LOAD_VALIDATION_REPORT.md's Synthetic Data
// Volume section, not just here): this bulk HISTORICAL data is generated
// via direct, schema-consistent `createMany` batches — NOT by calling the
// real domain functions (generateInvoice, recordPayment, ...) thousands of
// times sequentially, which would be far too slow for a "moderate, not
// millions of rows" bulk seed and is not what bulk background data is for.
// Financial rows are still constructed to be genuinely correct (invoice
// totals match their lines, journals are genuinely balanced Dr/Cr pairs
// posted against the real chart of accounts) so reconciliation checks
// after a load run are meaningful — but the CREATION multi-step business
// logic itself is only actually exercised, live, under real concurrency,
// by the dedicated concurrency scenarios in load-tests/concurrency/, which
// DO call the real domain functions. That split is deliberate: bulk seed
// data exists to make list/search/pagination/Patient360/dashboard reads
// realistic at scale; the concurrency scenarios are where correctness
// under concurrent writes is actually proven.
//
// Never touches his_dev/his_test — assertIsLoadTestDatabase fails closed.

import "dotenv/config"
import { randomUUID } from "node:crypto"
import { assertIsLoadTestDatabase, assertNotRemoteHost, requireEnv } from "../../scripts/db/lib"

const DIRECT_URL = requireEnv("LOAD_TEST_DIRECT_DATABASE_URL")
const RUNTIME_URL = requireEnv("LOAD_TEST_DATABASE_URL")
assertNotRemoteHost(DIRECT_URL, "LOAD_TEST_DIRECT_DATABASE_URL")
assertNotRemoteHost(RUNTIME_URL, "LOAD_TEST_DATABASE_URL")
assertIsLoadTestDatabase(DIRECT_URL, "LOAD_TEST_DIRECT_DATABASE_URL")
assertIsLoadTestDatabase(RUNTIME_URL, "LOAD_TEST_DATABASE_URL")

// Point the app's own Prisma singleton at his_load_test's OWNER connection
// (DDL isn't needed, but bulk createMany on 10,000s of rows is faster
// without going through the restricted role's per-statement overhead, and
// this script is a one-time data generator, not the running application —
// see scripts/db/dr-drill.ts for the same "set env before importing db.ts"
// pattern this reuses).
process.env.DATABASE_URL = DIRECT_URL

const FIRST_NAMES = ["Ahmed", "Fatima", "Mohammed", "Aisha", "Ali", "Sara", "Omar", "Layla", "Hassan", "Mariam", "Khalid", "Noor", "Yusuf", "Huda", "Ibrahim", "Rana", "Tariq", "Zainab", "Sami", "Dina", "Kareem", "Reem", "Waleed", "Salma", "Nasser", "Amal", "Faisal", "Hana", "Rashid", "Lina"]
const LAST_NAMES = ["Al-Sayed", "Rahman", "Hussain", "Khan", "Malik", "Farooq", "Nasser", "Saleh", "Qureshi", "Siddiqui", "Al-Amin", "Chaudhry", "Iqbal", "Sheikh", "Baig", "Butt", "Awan", "Raza", "Zaidi", "Jamil"]
const CITIES = ["Dubai", "Abu Dhabi", "Sharjah", "Karachi", "Lahore", "Islamabad", "Riyadh", "Jeddah", "Doha"]

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
}
function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000)
}
function pad(n: number, width = 6): string {
  return String(n).padStart(width, "0")
}

/** Batches a `createMany` over an array so a single call never sends an unreasonable parameter count. */
async function batchedCreateMany<T>(
  label: string,
  rows: T[],
  createMany: (batch: T[]) => Promise<unknown>,
  batchSize = 2000
): Promise<void> {
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize)
    await createMany(batch)
    process.stdout.write(`\r[${label}] ${Math.min(i + batchSize, rows.length)}/${rows.length}`)
  }
  console.log()
}

async function main() {
  const { db } = await import("../../src/lib/db")

  console.log("=".repeat(70))
  console.log("P4.5 Load-Test Data Generation — his_load_test")
  console.log("=".repeat(70))

  const organization = await db.organization.findFirstOrThrow()
  const orgId = organization.id
  const defaultBranch = await db.branch.findFirstOrThrow({ where: { organizationId: orgId } })

  // --- Branches -----------------------------------------------------------
  console.log("\n[1/12] Branches...")
  const branchIds = [defaultBranch.id]
  const extraBranches = [
    { id: randomUUID(), organizationId: orgId, name: "North Branch", code: "LT-NORTH", timezone: "Asia/Dubai" },
    { id: randomUUID(), organizationId: orgId, name: "South Branch", code: "LT-SOUTH", timezone: "Asia/Dubai" },
  ]
  await db.branch.createMany({ data: extraBranches })
  branchIds.push(...extraBranches.map((b) => b.id))
  console.log(`  ${branchIds.length} branches total.`)

  // --- Departments ----------------------------------------------------------
  const departments = branchIds.map((branchId, i) => ({ id: randomUUID(), branchId, name: `Department ${i + 1}`, code: `LT-DEPT-${i + 1}` }))
  await db.department.createMany({ data: departments })

  // --- Providers ------------------------------------------------------------
  console.log("[2/12] Providers, services, products...")
  const PROVIDER_COUNT = 30
  const providers = Array.from({ length: PROVIDER_COUNT }, () => ({
    id: randomUUID(), organizationId: orgId,
    providerType: pick(["doctor", "doctor", "doctor", "nurse", "other"] as const),
    firstName: pick(FIRST_NAMES), lastName: pick(LAST_NAMES),
    specialty: pick(["General Medicine", "Pediatrics", "Dermatology", "Orthopedics", "ENT", "Internal Medicine"]),
  }))
  await db.provider.createMany({ data: providers })
  const providerIds = providers.map((p) => p.id)

  // --- Services ---------------------------------------------------------------
  const SERVICE_COUNT = 60
  const services = Array.from({ length: SERVICE_COUNT }, (_, i) => ({
    id: randomUUID(), organizationId: orgId, name: `Service ${i + 1}`, code: `LT-SVC-${pad(i + 1, 4)}`,
    category: pick(["consultation", "procedure", "diagnostic", "therapy"]), price: randomInt(20, 500), durationMinutes: pick([15, 30, 45, 60]),
  }))
  await db.service.createMany({ data: services })
  const serviceIds = services.map((s) => s.id)

  // --- Products, batches, stock ledger -----------------------------------------
  const PRODUCT_COUNT = 150
  const products = Array.from({ length: PRODUCT_COUNT }, (_, i) => ({
    id: randomUUID(), organizationId: orgId, sku: `LT-SKU-${pad(i + 1, 5)}`, name: `Product ${i + 1}`,
    category: pick(["medication", "consumable", "equipment"]), unit: pick(["box", "unit", "bottle", "pack"]),
    purchaseCost: randomInt(5, 100), sellingPrice: randomInt(10, 200), reorderLevel: 20, minimumStock: 10,
  }))
  await db.product.createMany({ data: products })

  const batches: { id: string; organizationId: string; productId: string; batchNumber: string; manufacturingDate: Date; expiryDate: Date; purchaseCost: number; receivedQuantity: number }[] = []
  const stockEntries: { id: string; organizationId: string; branchId: string; productId: string; batchId: string; transactionType: "purchase" | "sale" | "dispensing" | "adjustment"; quantity: number; referenceType: string; referenceId: string; createdAt: Date }[] = []
  for (const product of products) {
    const batchCount = randomInt(2, 3)
    for (let b = 0; b < batchCount; b++) {
      const batchId = randomUUID()
      const isExpired = Math.random() < 0.1
      const receivedQty = randomInt(50, 500)
      batches.push({
        id: batchId, organizationId: orgId, productId: product.id, batchNumber: `LT-BATCH-${product.sku}-${b}`,
        manufacturingDate: daysAgo(randomInt(60, 400)), expiryDate: isExpired ? daysAgo(randomInt(1, 60)) : daysFromNow(randomInt(60, 700)),
        purchaseCost: product.purchaseCost, receivedQuantity: receivedQty,
      })
      const branchId = pick(branchIds)
      stockEntries.push({
        id: randomUUID(), organizationId: orgId, branchId, productId: product.id, batchId,
        transactionType: "purchase", quantity: receivedQty, referenceType: "load_test_seed", referenceId: batchId, createdAt: daysAgo(randomInt(30, 400)),
      })
      // A realistic partial consumption trail so balances aren't just the raw receipt.
      const consumed = Math.floor(receivedQty * randomInt(10, 60) / 100)
      if (consumed > 0) {
        stockEntries.push({
          id: randomUUID(), organizationId: orgId, branchId, productId: product.id, batchId,
          transactionType: pick(["sale", "dispensing", "adjustment"]), quantity: -consumed, referenceType: "load_test_seed", referenceId: batchId, createdAt: daysAgo(randomInt(1, 29)),
        })
      }
    }
  }
  await batchedCreateMany("batches", batches, (b) => db.productBatch.createMany({ data: b }))
  await batchedCreateMany("stock ledger", stockEntries, (b) => db.stockLedgerEntry.createMany({ data: b }))

  // --- Staff users ------------------------------------------------------------
  console.log("[3/12] Staff users (roles reused from the seeded system-role catalog)...")
  const roles = await db.role.findMany({ where: { organizationId: orgId } })
  const roleByName = new Map(roles.map((r) => [r.name, r.id]))
  const STAFF_COUNT = 250
  const roleWeights: [string, number][] = [
    ["Receptionist", 30], ["Nurse", 20], ["Doctor", 40], ["Laboratory Technician", 15], ["Radiology Technician", 10],
    ["Pharmacist", 15], ["Cashier", 20], ["Inventory Manager", 10], ["Accountant", 10], ["HR Manager", 5], ["Organization Administrator", 5],
  ]
  const weightedRolePool = roleWeights.flatMap(([name, count]) => roleByName.has(name) ? Array(count).fill(name) : [])
  const users = Array.from({ length: STAFF_COUNT }, (_, i) => ({
    id: randomUUID(), organizationId: orgId, email: `loadtest-staff-${i + 1}@load.test`,
    firstName: pick(FIRST_NAMES), lastName: pick(LAST_NAMES),
    // A fixed, known Argon2id hash for "LoadTest123!" — real hashing (not a
    // shortcut), generated once via the app's own hashPassword() and pasted
    // here as a constant so 250 users don't each pay Argon2's real cost
    // during bulk generation. Every load-test HTTP scenario logs in with
    // this exact password. Never used outside `his_load_test`.
    passwordHash: "$argon2id$v=19$m=65536,p=4,t=3$gZz4gB5SLyxz8inN/ZA59g$3W3uFzrpldzbqlz1W3HjKksOG9rJGaGI5VY0hy1mK7c",
    status: "active" as const,
  }))
  await batchedCreateMany("staff users", users, (b) => db.user.createMany({ data: b }))

  const userRoles: { userId: string; roleId: string }[] = []
  const userBranchAccess: { userId: string; branchId: string }[] = []
  for (const user of users) {
    const roleName = weightedRolePool.length > 0 ? pick(weightedRolePool) : "Receptionist"
    const roleId = roleByName.get(roleName)
    if (roleId) userRoles.push({ userId: user.id, roleId })
    const branchId = pick(branchIds)
    userBranchAccess.push({ userId: user.id, branchId })
  }
  await batchedCreateMany("user roles", userRoles, (b) => db.userRole.createMany({ data: b, skipDuplicates: true }))
  await batchedCreateMany("user branch access", userBranchAccess, (b) => db.userBranchAccess.createMany({ data: b, skipDuplicates: true }))

  // --- Patients -----------------------------------------------------------------
  console.log("[4/12] Patients...")
  const PATIENT_COUNT = 10_000
  const patients = Array.from({ length: PATIENT_COUNT }, (_, i) => {
    const dobYear = randomInt(1940, 2020)
    return {
      id: randomUUID(), organizationId: orgId, registrationBranchId: pick(branchIds),
      mrn: `LT-MRN-${pad(i + 1)}`, firstName: pick(FIRST_NAMES), lastName: pick(LAST_NAMES),
      dob: new Date(`${dobYear}-${pad(randomInt(1, 12), 2)}-${pad(randomInt(1, 28), 2)}`),
      gender: pick(["male", "female", "unknown"] as const),
      mobile: `05${randomInt(10000000, 99999999)}`,
      city: pick(CITIES),
      status: Math.random() < 0.05 ? ("inactive" as const) : ("active" as const),
      createdAt: daysAgo(randomInt(1, 700)),
    }
  })
  await batchedCreateMany("patients", patients, (b) => db.patient.createMany({ data: b }))

  // --- Appointments ---------------------------------------------------------------
  console.log("[5/12] Appointments...")
  const APPOINTMENT_COUNT = 20_000
  const appointmentStatusPool = ["completed", "completed", "completed", "completed", "cancelled", "no_show", "scheduled", "confirmed"] as const
  // `appointment_provider_no_overlap` is a real, correct exclusion
  // constraint (P2 — no double-booking a provider) — naive random
  // provider+time assignment collides constantly at this volume. Build the
  // full (provider × day × 30-min slot) grid instead and sample WITHOUT
  // REPLACEMENT, so every generated appointment is guaranteed a genuinely
  // free slot, the same guarantee the real booking flow enforces.
  type Slot = { providerId: string; start: Date }
  const slots: Slot[] = []
  const DAY_RANGE_PAST = 180
  const DAY_RANGE_FUTURE = 7
  const HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16] // 9 hours * 2 slots/hour = 18 slots/provider/day
  for (const providerId of providerIds) {
    for (let dayOffset = -DAY_RANGE_PAST; dayOffset <= DAY_RANGE_FUTURE; dayOffset++) {
      for (const hour of HOURS) {
        for (const minute of [0, 30]) {
          const start = dayOffset < 0 ? daysAgo(-dayOffset) : daysFromNow(dayOffset)
          start.setHours(hour, minute, 0, 0)
          slots.push({ providerId, start })
        }
      }
    }
  }
  // Fisher-Yates shuffle, then take the first APPOINTMENT_COUNT — cheap and
  // gives a realistic even spread across providers/days rather than always
  // filling the earliest slots first.
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[slots[i], slots[j]] = [slots[j], slots[i]]
  }
  const chosenSlots = slots.slice(0, Math.min(APPOINTMENT_COUNT, slots.length))

  const appointments: { id: string; organizationId: string; branchId: string; appointmentNumber: string; patientId: string; providerId: string; serviceId: string; startTime: Date; endTime: Date; status: (typeof appointmentStatusPool)[number] }[] = []
  chosenSlots.forEach((slot, i) => {
    const patient = pick(patients)
    const isFuture = slot.start.getTime() > Date.now()
    const status = isFuture ? pick(["scheduled", "confirmed"] as const) : pick(appointmentStatusPool)
    appointments.push({
      id: randomUUID(), organizationId: orgId, branchId: patient.registrationBranchId, appointmentNumber: `LT-APT-${pad(i + 1)}`,
      patientId: patient.id, providerId: slot.providerId, serviceId: pick(serviceIds),
      startTime: slot.start, endTime: new Date(slot.start.getTime() + 30 * 60_000), status,
    })
  })
  await batchedCreateMany("appointments", appointments, (b) => db.appointment.createMany({ data: b }))

  // --- Encounters (roughly the completed appointments) -----------------------------
  console.log("[6/12] Encounters + clinical orders...")
  const completedAppointments = appointments.filter((a) => a.status === "completed")
  const encounters = completedAppointments.map((apt, i) => ({
    id: randomUUID(), organizationId: orgId, branchId: apt.branchId, patientId: apt.patientId, providerId: apt.providerId,
    appointmentId: apt.id, encounterNumber: `LT-ENC-${pad(i + 1)}`, encounterType: "consultation" as const,
    status: "finalized" as const, startAt: apt.startTime, endAt: apt.endTime,
  }))
  await batchedCreateMany("encounters", encounters, (b) => db.encounter.createMany({ data: b }))

  const CLINICAL_ORDER_COUNT = 3000
  const orderTypePool = ["lab", "lab", "imaging", "procedure"] as const
  const clinicalOrders = Array.from({ length: CLINICAL_ORDER_COUNT }, (_, i) => {
    const enc = pick(encounters)
    return {
      id: randomUUID(), organizationId: orgId, branchId: enc.branchId, patientId: enc.patientId, encounterId: enc.id,
      orderNumber: `LT-ORD-${pad(i + 1)}`, orderType: pick(orderTypePool), orderingProviderId: enc.providerId,
      status: pick(["completed", "completed", "ordered", "in_progress"] as const), orderedAt: enc.startAt,
    }
  })
  await batchedCreateMany("clinical orders", clinicalOrders, (b) => db.clinicalOrder.createMany({ data: b }))

  // --- Financial: charges, invoices, invoice lines, payments, allocations, journals ---
  console.log("[7/12] Financial data (charges/invoices/payments/journals)...")
  const accounts = await db.chartOfAccount.findMany({ where: { organizationId: orgId } })
  const accountByCode = new Map(accounts.map((a) => [a.code, a.id]))
  const cashAccountId = accountByCode.get("1000")!
  const arAccountId = accountByCode.get("1100")!
  const revenueAccountId = accountByCode.get("4000")!

  const INVOICE_COUNT = 10_000
  const charges: { id: string; organizationId: string; branchId: string; patientId: string; providerId: string; sourceType: "consultation"; description: string; quantity: number; unitPrice: number; amount: number; status: "invoiced" }[] = []
  const invoices: { id: string; organizationId: string; branchId: string; invoiceNumber: string; patientId: string; providerId: string; status: "issued" | "partially_paid" | "paid"; subtotal: number; totalAmount: number; paidAmount: number; issuedAt: Date; createdAt: Date }[] = []
  const invoiceLines: { id: string; invoiceId: string; chargeId: string; description: string; quantity: number; unitPrice: number; lineTotal: number }[] = []
  const payments: { id: string; organizationId: string; branchId: string; receiptNumber: string; method: "cash" | "card"; amount: number; status: "completed"; receivedAt: Date }[] = []
  const paymentAllocations: { id: string; paymentId: string; invoiceId: string; amount: number }[] = []
  const journals: { id: string; organizationId: string; branchId: string; journalNumber: string; journalDate: Date; referenceType: string; referenceId: string; description: string; createdAt: Date }[] = []
  const journalLines: { id: string; journalId: string; accountId: string; debit: number; credit: number }[] = []

  let journalSeq = 0
  for (let i = 0; i < INVOICE_COUNT; i++) {
    const patient = pick(patients)
    const branchId = patient.registrationBranchId
    const lineCount = randomInt(1, 3)
    const lineIds: string[] = []
    let subtotal = 0
    for (let l = 0; l < lineCount; l++) {
      const chargeId = randomUUID()
      const unitPrice = randomInt(30, 400)
      charges.push({
        id: chargeId, organizationId: orgId, branchId, patientId: patient.id, providerId: pick(providerIds),
        sourceType: "consultation", description: "Load-test charge", quantity: 1, unitPrice, amount: unitPrice, status: "invoiced",
      })
      lineIds.push(chargeId)
      subtotal += unitPrice
    }
    const invoiceId = randomUUID()
    const issuedAt = daysAgo(randomInt(0, 180))
    // 60% fully paid, 25% partially paid, 15% unpaid — a realistic AR distribution.
    const paidFraction = Math.random() < 0.6 ? 1 : Math.random() < 0.6 ? Math.random() * 0.7 + 0.1 : 0
    const paidAmount = Math.round(subtotal * paidFraction * 100) / 100
    const status = paidAmount >= subtotal ? "paid" : paidAmount > 0 ? "partially_paid" : "issued"
    invoices.push({
      id: invoiceId, organizationId: orgId, branchId, invoiceNumber: `LT-INV-${pad(i + 1)}`, patientId: patient.id,
      providerId: pick(providerIds), status, subtotal, totalAmount: subtotal, paidAmount, issuedAt, createdAt: issuedAt,
    })
    for (const chargeId of lineIds) {
      const charge = charges[charges.length - lineIds.length + lineIds.indexOf(chargeId)]
      invoiceLines.push({ id: randomUUID(), invoiceId, chargeId, description: charge.description, quantity: 1, unitPrice: charge.unitPrice, lineTotal: charge.amount })
    }

    // InvoiceIssued journal — Dr AR / Cr Revenue, always balanced by construction.
    journalSeq++
    const issueJournalId = randomUUID()
    journals.push({ id: issueJournalId, organizationId: orgId, branchId, journalNumber: `LT-JRN-${pad(journalSeq)}`, journalDate: issuedAt, referenceType: "InvoiceIssued", referenceId: invoiceId, description: "Load-test invoice issued", createdAt: issuedAt })
    journalLines.push({ id: randomUUID(), journalId: issueJournalId, accountId: arAccountId, debit: subtotal, credit: 0 })
    journalLines.push({ id: randomUUID(), journalId: issueJournalId, accountId: revenueAccountId, debit: 0, credit: subtotal })

    if (paidAmount > 0) {
      const paymentId = randomUUID()
      const receivedAt = new Date(issuedAt.getTime() + randomInt(0, 3) * 24 * 60 * 60_000)
      payments.push({ id: paymentId, organizationId: orgId, branchId, receiptNumber: `LT-PAY-${pad(i + 1)}`, method: pick(["cash", "card"]), amount: paidAmount, status: "completed", receivedAt })
      paymentAllocations.push({ id: randomUUID(), paymentId, invoiceId, amount: paidAmount })

      journalSeq++
      const paymentJournalId = randomUUID()
      journals.push({ id: paymentJournalId, organizationId: orgId, branchId, journalNumber: `LT-JRN-${pad(journalSeq)}`, journalDate: receivedAt, referenceType: "PaymentReceived", referenceId: paymentId, description: "Load-test payment received", createdAt: receivedAt })
      journalLines.push({ id: randomUUID(), journalId: paymentJournalId, accountId: cashAccountId, debit: paidAmount, credit: 0 })
      journalLines.push({ id: randomUUID(), journalId: paymentJournalId, accountId: arAccountId, debit: 0, credit: paidAmount })
    }
  }
  await batchedCreateMany("charges", charges, (b) => db.charge.createMany({ data: b }))
  await batchedCreateMany("invoices", invoices, (b) => db.invoice.createMany({ data: b }))
  await batchedCreateMany("invoice lines", invoiceLines, (b) => db.invoiceLine.createMany({ data: b }))
  await batchedCreateMany("payments", payments, (b) => db.payment.createMany({ data: b }))
  await batchedCreateMany("payment allocations", paymentAllocations, (b) => db.paymentAllocation.createMany({ data: b }))
  await batchedCreateMany("journals", journals, (b) => db.journal.createMany({ data: b }))
  await batchedCreateMany("journal lines", journalLines, (b) => db.journalLine.createMany({ data: b }))

  // --- Login history --------------------------------------------------------------
  console.log("[8/12] Login history...")
  const LOGIN_HISTORY_COUNT = 3000
  const loginRows = Array.from({ length: LOGIN_HISTORY_COUNT }, (_, i) => {
    const success = Math.random() < 0.85
    return {
      id: randomUUID(), channel: pick(["staff", "staff", "staff", "portal"] as const),
      emailAttempted: `loadtest-history-${i}@load.test`, success,
      ip: `203.0.113.${randomInt(1, 254)}`,
      reason: success ? null : pick(["bad_password", "bad_password", "user_not_found"]),
      createdAt: daysAgo(randomInt(0, 60)),
    }
  })
  await batchedCreateMany("login history", loginRows, (b) => db.loginHistory.createMany({ data: b }))

  // --- Outbox history --------------------------------------------------------------
  console.log("[9/12] Outbox event history...")
  const OUTBOX_HISTORY_COUNT = 5000
  const outboxRows = Array.from({ length: OUTBOX_HISTORY_COUNT }, (_, i) => {
    // 98% completed, a small realistic sliver of dead-letter/failed —
    // production accumulates some over time; a zero-dead-letter baseline
    // would be an unrealistic starting point for exercising the operations
    // dashboard at scale.
    const roll = Math.random()
    const status = roll < 0.98 ? "completed" : roll < 0.995 ? "failed" : "dead_letter"
    return {
      id: randomUUID(), organizationId: orgId, eventType: pick(["InvoiceIssued", "PaymentReceived", "InventoryAdjusted"]),
      payload: { loadTestSeed: true, index: i }, status: status as "completed" | "failed" | "dead_letter",
      attempts: status === "completed" ? 1 : 3, createdAt: daysAgo(randomInt(0, 60)),
      completedAt: status === "completed" ? daysAgo(randomInt(0, 60)) : null,
      lastError: status === "completed" ? null : "Load-test seed synthetic failure",
    }
  })
  await batchedCreateMany("outbox history", outboxRows, (b) => db.outboxEvent.createMany({ data: b }))

  console.log("[10/12] Verifying counts...")
  const [pCount, aCount, eCount, iCount, jCount, sCount] = await Promise.all([
    db.patient.count({ where: { organizationId: orgId } }),
    db.appointment.count({ where: { organizationId: orgId } }),
    db.encounter.count({ where: { organizationId: orgId } }),
    db.invoice.count({ where: { organizationId: orgId } }),
    db.journal.count({ where: { organizationId: orgId } }),
    db.stockLedgerEntry.count({ where: { organizationId: orgId } }),
  ])

  console.log("[11/12] Done generating. [12/12] Summary:")
  console.log(JSON.stringify({ patients: pCount, appointments: aCount, encounters: eCount, invoices: iCount, journals: jCount, stockLedgerEntries: sCount, staffUsers: STAFF_COUNT, branches: branchIds.length, providers: PROVIDER_COUNT, products: PRODUCT_COUNT }, null, 2))

  await db.$disconnect()
}

main().catch((err) => {
  console.error(`\nload-data generation failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
  process.exit(1)
})
