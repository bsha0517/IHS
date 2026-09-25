import { test, expect } from "@playwright/test"
import { loginAsClinicUser, readFixture, patchFixture, withDb, type PilotFixture } from "./fixtures"

/**
 * P5.3 Step 7/8 — lab and radiology technician UAT, against the real lab
 * order the doctor stage created for Aisha, plus a quick second encounter
 * for Bilal specifically to exercise the imaging workflow (the doctor
 * stage only created a lab order — a real clinic day has both).
 */
test.describe.serial("P5.3 Lab UAT", () => {
  let fixture: PilotFixture

  test("lab technician: assign tests (generates a charge), collect + receive specimen, enter a numeric result, verify it", async ({ page }) => {
    test.setTimeout(120_000)
    fixture = readFixture()
    await loginAsClinicUser(page, fixture.users.labTech.email, fixture.users.labTech.password)
    await page.goto(`/laboratory/orders/${fixture.patients.labOrderId}`)
    // Not a semantic "Order" heading — the order id/intent text on this
    // page isn't rendered as a role="heading" element. "Assign tests" is
    // the real, specific signal the order page loaded correctly.
    await expect(page.getByRole("button", { name: "Assign tests" })).toBeVisible({ timeout: 15_000 })

    await page.getByRole("button", { name: "Assign tests" }).click()
    {
      const dlg = page.getByRole("dialog")
      await dlg.getByLabel("Specimen type").fill("Whole blood")
      await dlg.getByLabel(new RegExp(fixture.labTests.cbcName)).check()
      await dlg.getByRole("button", { name: "Assign & generate charges" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })

    // A Charge must exist at assignment time, not later — matches the
    // architecture the exploration confirmed (generateSystemCharge fires
    // inside assignTests itself).
    const chargeAfterAssign = await withDb((db) =>
      db.query<{ count: string }>(`select count(*)::text from charge where organization_id=$1 and source_type='lab'`, [fixture.organizationId])
    )
    expect(Number(chargeAfterAssign.rows[0].count)).toBeGreaterThanOrEqual(1)

    await page.getByRole("button", { name: "Mark collected" }).click()
    await expect(page.getByText(/collected/i).first()).toBeVisible({ timeout: 10_000 })
    await page.getByRole("button", { name: "Mark received" }).click()
    await expect(page.getByText(/received/i).first()).toBeVisible({ timeout: 10_000 })

    await page.getByRole("button", { name: "Enter result" }).click()
    {
      const dlg = page.getByRole("dialog")
      const valueField = dlg.getByLabel(/Value/).first()
      await valueField.fill("13.5")
      await dlg.getByRole("button", { name: "Save result" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })

    const labResult = await withDb((db) =>
      db.query<{ status: string; abnormal_flag: string | null }>(
        `select status, abnormal_flag from lab_order_test where clinical_order_id=(select id from clinical_order where id=$1)`,
        [fixture.patients.labOrderId]
      )
    )
    expect(labResult.rows[0]?.status).toBe("resulted")

    await page.getByRole("button", { name: "Verify" }).click()
    await expect(page.getByText(/verified/i).first()).toBeVisible({ timeout: 10_000 });

    const finalStatus = await withDb((db) =>
      db.query<{ status: string }>(`select status from lab_order_test where clinical_order_id=$1`, [fixture.patients.labOrderId])
    )
    expect(finalStatus.rows[0].status).toBe("verified")
  })

  test("REQUIRED — a verified lab result is never edited in place; amending creates a NEW row, the old one stays as history", async ({ page }) => {
    test.setTimeout(90_000)
    fixture = readFixture()
    await loginAsClinicUser(page, fixture.users.labTech.email, fixture.users.labTech.password)
    await page.goto(`/laboratory/orders/${fixture.patients.labOrderId}`)

    const beforeAmend = await withDb((db) =>
      db.query<{ count: string }>(`select count(*)::text from lab_order_test where clinical_order_id=$1`, [fixture.patients.labOrderId])
    )

    await page.getByRole("button", { name: "Amend result" }).click()
    {
      const dlg = page.getByRole("dialog")
      const valueField = dlg.getByLabel(/Value/).first()
      await valueField.fill("14.1")
      await dlg.getByLabel("Notes").fill("Corrected transcription error — UAT amendment test")
      await dlg.getByRole("button", { name: "Save amendment" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })

    const afterAmend = await withDb((db) =>
      db.query<{ count: string; current_count: string }>(
        `select count(*)::text, count(*) filter (where is_current)::text as current_count from lab_order_test where clinical_order_id=$1`,
        [fixture.patients.labOrderId]
      )
    )
    expect(Number(afterAmend.rows[0].count), "amending must INSERT a new row, never UPDATE the verified one in place").toBe(Number(beforeAmend.rows[0].count) + 1)
    expect(afterAmend.rows[0].current_count).toBe("1")
  })
})

test.describe.serial("P5.3 Radiology UAT", () => {
  let fixture: PilotFixture
  let imagingOrderId: string

  test("doctor: start a second encounter for Bilal and place an imaging order (the doctor stage only covered lab)", async ({ page }) => {
    test.setTimeout(90_000)
    fixture = readFixture()
    await loginAsClinicUser(page, fixture.users.doctor1.email, fixture.users.doctor1.password)
    await page.goto(`/appointments/${fixture.patients.bilalAppointmentId}`)
    // Bilal's appointment was rebooked (a new row, "scheduled") when
    // reception rescheduled it — "Start encounter" only appears once an
    // appointment reaches "waiting"/"in_consultation" (status-actions.tsx),
    // so it needs the same real Confirm -> Mark arrived -> Check in
    // sequence reception uses, not a bypass. Doctor holds appointment.checkin
    // too (system-roles.ts), so doctor1 can legitimately run it here.
    await page.getByRole("button", { name: "Confirm" }).click()
    await expect(page.getByRole("button", { name: "Mark arrived" })).toBeVisible({ timeout: 10_000 })
    await page.getByRole("button", { name: "Mark arrived" }).click()
    await expect(page.getByRole("button", { name: "Check in" })).toBeVisible({ timeout: 10_000 })
    await page.getByRole("button", { name: "Check in" }).click()
    await expect(page.getByRole("button", { name: "Start encounter" })).toBeVisible({ timeout: 10_000 })

    // startEncounterAction redirects server-side straight to
    // /encounters/{id} — no intermediate "Open encounter" link state.
    await page.getByRole("button", { name: "Start encounter" }).click()
    await page.waitForURL(/\/encounters\/[^/]+$/, { timeout: 15_000 })
    const bilalEncounterId = page.url().split("/").pop()!
    await expect(page.getByRole("button", { name: "Complete encounter" })).toBeVisible({ timeout: 15_000 })

    await page.getByRole("button", { name: "Add order" }).click()
    {
      const dlg = page.getByRole("dialog")
      await dlg.getByRole("combobox", { name: "Order type" }).click()
      await page.getByRole("option", { name: "Imaging", exact: true }).click()
      await dlg.getByLabel("Imaging type").fill(fixture.imagingServices.xrayName)
      await dlg.getByLabel("Body part").fill("Chest")
      await dlg.getByLabel("Reason / clinical notes").fill("Rule out infection — UAT synthetic imaging order")
      await dlg.getByRole("button", { name: "Place order" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })

    const order = await withDb((db) =>
      db.query<{ id: string }>(`select id from clinical_order where encounter_id=$1 and order_type='imaging' order by ordered_at desc limit 1`, [bilalEncounterId])
    )
    expect(order.rows[0]?.id, "imaging ClinicalOrder must exist").toBeTruthy()
    patchFixture({ patients: { ...fixture.patients, bilalEncounterId, imagingOrderId: order.rows[0].id } })
  })

  test("radiology technician: assign imaging service (generates a charge), schedule, mark performed, write report, verify", async ({ page }) => {
    test.setTimeout(120_000)
    fixture = readFixture()
    imagingOrderId = fixture.patients.imagingOrderId
    await loginAsClinicUser(page, fixture.users.radTech.email, fixture.users.radTech.password)
    await page.goto(`/radiology/orders/${imagingOrderId}`)
    // Not a semantic "Order" heading — see the same fix's comment in the
    // lab-order test above. "Assign service" is the real signal here.
    await expect(page.getByRole("button", { name: "Assign service" })).toBeVisible({ timeout: 15_000 })

    await page.getByRole("button", { name: "Assign service" }).click()
    {
      const dlg = page.getByRole("dialog")
      await dlg.getByRole("combobox", { name: "Imaging service" }).click()
      await page.getByRole("option", { name: new RegExp(fixture.imagingServices.xrayName) }).click()
      await dlg.getByRole("button", { name: "Assign & generate charge" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })

    const charge = await withDb((db) =>
      db.query<{ count: string }>(`select count(*)::text from charge where organization_id=$1 and source_type='imaging'`, [fixture.organizationId])
    )
    expect(Number(charge.rows[0].count)).toBeGreaterThanOrEqual(1)

    await page.getByRole("button", { name: "Schedule" }).click()
    {
      const dlg = page.getByRole("dialog")
      const now = new Date()
      now.setMinutes(now.getMinutes() + 15)
      const localIso = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
      await dlg.locator('input[type="datetime-local"]').fill(localIso)
      await dlg.getByRole("button", { name: "Schedule" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })

    await page.getByRole("button", { name: "Mark performed" }).click()
    await expect(page.getByText(/performed/i).first()).toBeVisible({ timeout: 10_000 })

    await page.getByRole("button", { name: "Write report" }).click()
    {
      const dlg = page.getByRole("dialog")
      await dlg.getByLabel("Findings").fill("No acute cardiopulmonary abnormality. UAT synthetic finding.")
      await dlg.getByLabel("Impression").fill("Normal chest X-ray — UAT synthetic impression.")
      await dlg.getByRole("button", { name: "Save report" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })

    await page.getByRole("button", { name: "Verify" }).click()
    await expect(page.getByText(/verified/i).first()).toBeVisible({ timeout: 10_000 })

    // imagingOrderId (from the setup test's fixture patch) is actually the
    // ClinicalOrder's own id, not ImagingOrder's — ImagingOrder is a
    // separate table keyed by clinical_order_id.
    const finalStatus = await withDb((db) => db.query<{ status: string }>(`select status from imaging_order where clinical_order_id=$1`, [imagingOrderId]))
    expect(finalStatus.rows[0].status).toBe("verified")
  })

  test("REQUIRED — amending a verified imaging report requires a reason and never mutates the original report", async ({ page }) => {
    test.setTimeout(90_000)
    fixture = readFixture()
    imagingOrderId = fixture.patients.imagingOrderId
    await loginAsClinicUser(page, fixture.users.radTech.email, fixture.users.radTech.password)
    await page.goto(`/radiology/orders/${imagingOrderId}`)

    await page.getByRole("button", { name: "Amend report" }).click()
    {
      const dlg = page.getByRole("dialog")
      await dlg.getByLabel("Reason for amendment").fill("Radiologist added a follow-up recommendation — UAT amendment test")
      await dlg.getByRole("button", { name: "Save amendment" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })

    // imagingOrderId is the ClinicalOrder's id — ImagingOrder itself has a
    // separate id, keyed by clinical_order_id (same note as the previous test).
    const amendments = await withDb((db) =>
      db.query<{ count: string }>(
        `select count(*)::text from imaging_report_amendment where imaging_order_id=(select id from imaging_order where clinical_order_id=$1)`,
        [imagingOrderId]
      )
    )
    expect(Number(amendments.rows[0].count), "an amendment must be recorded as its own row, never a silent edit").toBeGreaterThanOrEqual(1)

    const original = await withDb((db) => db.query<{ status: string }>(`select status from imaging_order where clinical_order_id=$1`, [imagingOrderId]))
    expect(original.rows[0].status).toBe("verified")
  })
})
