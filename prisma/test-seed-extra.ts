// Additional, test-only baseline fixtures — layered on top of the real
// `prisma/seed.ts` (never modified by this file, never run against `his_dev`
// or any real deployment). Run only by `npm run db:test:setup`/`db:test:reset`
// (scripts/db/test-setup.ts / test-reset.ts), against `his_test` only.
//
// Why this exists: the integration suite has run, for its entire history,
// against a single shared Supabase dev database that accumulated real rows
// organically over months of manual browser verification and ad hoc
// integration scripts across every P0/P1/P2 batch — a second Branch, at
// least one Provider, at least one Product. `prisma/seed.ts` itself only
// ever created ONE branch and never created a Provider or Product at all
// (verified directly — grep `prisma/seed.ts` for "db.branch."/"db.provider."/
// "db.product." — the org/branch/chart-of-accounts/catalog rows it creates,
// nothing else). That gap was invisible for the whole engagement because the
// old shared database was never actually empty. Building `his_test` from
// scratch made it visible for the first time: `npm run test:integration`'s
// first real run against a freshly seeded `his_test` failed 8 files with a
// `findFirstOrThrow` "No record was found" (Provider/Product) or "Test
// requires at least 2 seeded branches" (branch-isolation.test.ts,
// schema-quality-p2-batch2.test.ts) — real, reproducible evidence of exactly
// what's missing, not a guess.
//
// This file adds exactly that — no more — as its own explicit, documented
// step, per this task's own "do NOT seed... unless tests depend on
// explicitly documented seed fixtures" instruction. Idempotent (checks
// before creating, the same pattern prisma/seed.ts's own branch/department/
// room creation already uses), so `db:test:setup` stays safe to re-run.

import "dotenv/config"
import { db } from "../src/lib/db"
import { hashPassword } from "../src/lib/auth/password"

async function main() {
  const organization = await db.organization.findFirstOrThrow()
  const primaryBranch = await db.branch.findFirstOrThrow({ where: { organizationId: organization.id } })

  // A second Branch — test/integration/branch-isolation.test.ts (P0-01) and
  // test/integration/schema-quality-p2-batch2.test.ts (P2 §13) both require
  // at least two real branches under the same organization to prove
  // cross-branch data is NOT visible across them.
  let secondBranch = await db.branch.findFirst({
    where: { organizationId: organization.id, id: { not: primaryBranch.id } },
  })
  if (!secondBranch) {
    console.log("Creating second branch (his_test only — branch isolation tests need two)...")
    secondBranch = await db.branch.create({
      data: {
        organizationId: organization.id,
        name: "Second Branch",
        code: "SECOND",
        timezone: organization.defaultTimezone,
      },
    })
  }

  // A Provider — required by several files (appointment-double-booking,
  // cascade-delete-protection, clinical-record-cancellation,
  // pharmacy-dispensing-integrity, admin-viewers-p2-batch5) via
  // `db.provider.findFirstOrThrow()`.
  let provider = await db.provider.findFirst({ where: { organizationId: organization.id } })
  if (!provider) {
    console.log("Creating baseline provider (his_test only)...")
    provider = await db.provider.create({
      data: {
        organizationId: organization.id,
        providerType: "doctor",
        firstName: "Test",
        lastName: "Provider",
      },
    })
  }

  // A Service — required by branch-isolation.test.ts and
  // cascade-delete-protection.test.ts via `db.service.findFirstOrThrow()`.
  let service = await db.service.findFirst({ where: { organizationId: organization.id } })
  if (!service) {
    console.log("Creating baseline service (his_test only)...")
    service = await db.service.create({
      data: {
        organizationId: organization.id,
        code: "TESTSVC",
        name: "Test Consultation",
        category: "consultation",
        durationMinutes: 30,
        price: 100,
      },
    })
  }

  // A Product — required by pagination-p2-batch6.test.ts via
  // `db.product.findFirstOrThrow()`.
  let product = await db.product.findFirst({ where: { organizationId: organization.id } })
  if (!product) {
    console.log("Creating baseline product (his_test only)...")
    product = await db.product.create({
      data: {
        organizationId: organization.id,
        name: "Test Product",
        sku: "TESTSKU",
        category: "consumable",
        unit: "unit",
        reorderLevel: 0,
        purchaseCost: 1,
        sellingPrice: 2,
      },
    })
  }

  // A Patient — required by appointment-double-booking.test.ts (and others)
  // via `db.patient.findFirstOrThrow()`. `prisma/seed.ts` never creates one
  // (verified directly, same reasoning as every other fixture in this file).
  let patient = await db.patient.findFirst({ where: { organizationId: organization.id } })
  if (!patient) {
    console.log("Creating baseline patient (his_test only)...")
    patient = await db.patient.create({
      data: {
        organizationId: organization.id,
        registrationBranchId: primaryBranch.id,
        mrn: "TEST-MRN-0001",
        firstName: "Test",
        lastName: "Patient",
        dob: new Date("1990-01-01"),
        gender: "unknown",
        mobile: "0000000000",
      },
    })
  }

  // A SECOND User — found during P5.4's regression pass:
  // test/integration/p3-11-notifications-operational-awareness.test.ts
  // (and any other file assuming ≥2 distinct
  // users exist) does `db.user.findMany({ take: 2 })` then
  // `userBId = users[1]?.id ?? users[0].id` — with only one seeded user
  // present, that fallback silently makes "user B" the SAME person as
  // "user A", turning an ownership-isolation test into a false failure
  // (it correctly finds its own notification "leaking" into its own list,
  // because there was only ever one real recipient). `prisma/seed.ts`
  // creates exactly one clinic user (the bootstrap Super Admin) — this adds
  // a second, real, distinct one so that assumption holds.
  let secondUser = await db.user.findFirst({ where: { organizationId: organization.id, email: "test-second-user@test.local" } })
  if (!secondUser) {
    console.log("Creating second baseline user (his_test only — tests assuming 2 distinct users need one)...")
    secondUser = await db.user.create({
      data: {
        organizationId: organization.id,
        email: "test-second-user@test.local",
        passwordHash: await hashPassword("not-a-real-login-throwaway"),
        firstName: "Test",
        lastName: "SecondUser",
      },
    })
  }

  console.log("Extra test fixtures ready:", {
    secondBranchId: secondBranch.id,
    providerId: provider.id,
    serviceId: service.id,
    productId: product.id,
    patientId: patient.id,
    secondUserId: secondUser.id,
  })
}

main()
  .catch((err) => {
    console.error("test-seed-extra failed:", err instanceof Error ? err.message : err)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
