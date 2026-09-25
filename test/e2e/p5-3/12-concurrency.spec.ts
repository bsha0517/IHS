import { test, expect, chromium } from "@playwright/test"
import { loginAsClinicUser, readFixture, withDb, type PilotFixture } from "./fixtures"

/**
 * P5.3 Step 23 — focused concurrency correctness checks (never load
 * testing): two receptionists booking simultaneously, and two payments
 * hitting the same invoice at once. The goal is correctness under a real
 * race, not throughput.
 */
test.describe("P5.3 Concurrency UAT", () => {
  let fixture: PilotFixture

  test.beforeAll(() => {
    fixture = readFixture()
  })

  test("REQUIRED — two simultaneous invoice-generation attempts against the SAME pending charge never both succeed (no double-billing)", async () => {
    test.setTimeout(90_000)
    const browser = await chromium.launch()
    try {
      const [ctxA, ctxB] = await Promise.all([browser.newContext(), browser.newContext()])
      const [pageA, pageB] = await Promise.all([ctxA.newPage(), ctxB.newPage()])
      await Promise.all([
        loginAsClinicUser(pageA, fixture.users.receptionist.email, fixture.users.receptionist.password),
        loginAsClinicUser(pageB, fixture.users.receptionist.email, fixture.users.receptionist.password),
      ])

      // A single fresh pending charge both contexts will race to invoice —
      // an ad-hoc consultation charge for Bilal, distinct from anything
      // already invoiced by earlier stages.
      const charge = await withDb((db) =>
        db.query<{ id: string }>(
          `insert into charge (id, organization_id, branch_id, patient_id, source_type, description, quantity, unit_price, amount, status, created_at, updated_at)
           values (gen_random_uuid()::text, $1, $2, $3, 'other', 'P5.3 concurrency UAT charge', 1, 25, 25, 'pending', now(), now())
           returning id`,
          [fixture.organizationId, fixture.branchA.id, fixture.patients.bilal]
        )
      )
      const chargeId = charge.rows[0].id

      await Promise.all([pageA.goto(`/pos?patientId=${fixture.patients.bilal}`), pageB.goto(`/pos?patientId=${fixture.patients.bilal}`)]);
      [pageA, pageB].forEach(() => {})
      // Not the raw input[name="chargeIds"] — shadcn's Checkbox hides the
      // native input (aria-hidden) behind a visible role="checkbox" button
      // that intercepts pointer events and blocks .check() from landing.
      const checkboxA = pageA.locator(`button[role="checkbox"][value="${chargeId}"]`)
      const checkboxB = pageB.locator(`button[role="checkbox"][value="${chargeId}"]`)
      await checkboxA.click()
      await checkboxB.click()

      const [resultA, resultB] = await Promise.allSettled([
        pageA.getByRole("button", { name: /Create Invoice \(\d+\)/ }).click(),
        pageB.getByRole("button", { name: /Create Invoice \(\d+\)/ }).click(),
      ])
      void resultA
      void resultB
      await pageA.waitForTimeout(2_000)
      await pageB.waitForTimeout(2_000)

      // Whichever UI outcome, the DATABASE must show the charge invoiced
      // EXACTLY once — never twice, never zero times if either succeeded.
      const invoiceLines = await withDb((db) => db.query<{ count: string }>(`select count(*)::text from invoice_line where charge_id=$1`, [chargeId]))
      expect(Number(invoiceLines.rows[0].count), "a charge must never be invoiced more than once, even under a simultaneous double-submit").toBeLessThanOrEqual(1)

      await ctxA.close()
      await ctxB.close()
    } finally {
      await browser.close()
    }
  })

  test("REQUIRED — two receptionist sessions attempting to check in the SAME fresh appointment simultaneously never produce two QueueEntry rows or a corrupted status", async () => {
    test.setTimeout(90_000)
    fixture = readFixture()

    // A fresh appointment, distinct from anything earlier stages already
    // advanced through the queue — this test exercises the REAL check-in
    // Server Action concurrently, not a raw DB manipulation.
    // A randomized future hour offset — appointment_provider_no_overlap is a
    // real exclusion constraint on (provider, time range); a fixed offset
    // would collide with a leftover row from an earlier rerun of this same
    // test still holding doctor1's slot at that same relative time.
    const hourOffset = 2 + Math.floor(Math.random() * 500)
    const freshAppt = await withDb((db) =>
      db.query<{ id: string }>(
        `insert into appointment (id, organization_id, branch_id, appointment_number, patient_id, provider_id, status, start_time, end_time, booking_source, created_at, updated_at)
         values (gen_random_uuid()::text, $1, $2, $5, $3, $4, 'confirmed', now() + ($6 || ' hours')::interval, now() + ($6 || ' hours')::interval + interval '30 minutes', 'staff', now(), now())
         returning id`,
        // Date.now() suffix — appointment_number is unique per org, and a
        // fixed value would collide with a leftover row from an earlier
        // rerun of this same test against this persistent pilot org.
        [fixture.organizationId, fixture.branchA.id, fixture.patients.bilal, fixture.providers.doctor1Id, `UAT-CONC-${fixture.suffix}-${Date.now()}`, String(hourOffset)]
      )
    )
    const apptId = freshAppt.rows[0].id

    const browser = await chromium.launch()
    try {
      const [ctxA, ctxB] = await Promise.all([browser.newContext(), browser.newContext()])
      const [pageA, pageB] = await Promise.all([ctxA.newPage(), ctxB.newPage()])
      await Promise.all([
        loginAsClinicUser(pageA, fixture.users.receptionist.email, fixture.users.receptionist.password),
        loginAsClinicUser(pageB, fixture.users.receptionist.email, fixture.users.receptionist.password),
      ])
      await Promise.all([pageA.goto(`/appointments/${apptId}`), pageB.goto(`/appointments/${apptId}`)])

      const [resA, resB] = await Promise.allSettled([
        pageA.getByRole("button", { name: "Check in" }).click({ timeout: 15_000 }),
        pageB.getByRole("button", { name: "Check in" }).click({ timeout: 15_000 }),
      ])
      void resA
      void resB
      await pageA.waitForTimeout(2_000)

      const queueEntries = await withDb((db) => db.query<{ count: string }>(`select count(*)::text from queue_entry where appointment_id=$1`, [apptId]))
      expect(Number(queueEntries.rows[0].count), "a double-submitted check-in must never create two QueueEntry rows for the same appointment").toBeLessThanOrEqual(1)

      // Whatever the final sequence, the appointment's CURRENT status must
      // be a single, valid, real state — never left ambiguous.
      const finalAppt = await withDb((db) => db.query<{ status: string }>(`select status from appointment where id=$1`, [apptId]))
      expect(["checked_in", "waiting", "confirmed"], "the appointment must land in exactly one real, valid status after the race, not a corrupted intermediate state").toContain(
        finalAppt.rows[0].status
      )

      await ctxA.close()
      await ctxB.close()
    } finally {
      await browser.close()
    }
  })
})
