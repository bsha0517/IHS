import { test, expect } from "@playwright/test"
import { loginAsClinicUser, readFixture, patchFixture, withDb, type PilotFixture } from "./fixtures"

/**
 * P5.3 Step 5/6 — doctor (and nurse) UAT: patient → appointment → encounter
 * → vitals → diagnosis → order (lab) → prescription → finalization. Runs
 * as doctor1 (Branch A) against Aisha's already-checked-in appointment from
 * the reception stage — the exact same real appointment a real doctor would
 * pick up next, not a freshly-fabricated one.
 */
test.describe.serial("P5.3 Doctor + Nursing UAT", () => {
  let fixture: PilotFixture
  let encounterId: string

  test("start an encounter from Aisha's checked-in appointment, and record vitals as the doctor", async ({ page }) => {
    test.setTimeout(90_000)
    fixture = readFixture()
    await loginAsClinicUser(page, fixture.users.doctor1.email, fixture.users.doctor1.password)
    await page.goto(`/appointments/${fixture.patients.aishaAppointmentId}`)

    // startEncounterAction redirects server-side straight to
    // /encounters/{id} on success — there's no intermediate "Open
    // encounter" link state to wait for; that link only appears on a LATER
    // load of the appointment page, once encounterId is already set.
    await page.getByRole("button", { name: "Start encounter" }).click()
    await page.waitForURL(/\/encounters\/[^/]+$/, { timeout: 15_000 })
    encounterId = page.url().split("/").pop()!
    // The encounter header has no semantic "Encounter" heading text (it
    // shows the patient's name and ENC-number instead) — "Complete
    // encounter" is the reliable, specific signal this is a real active
    // encounter page, and this test relies on that same button below anyway.
    await expect(page.getByRole("button", { name: "Complete encounter" })).toBeVisible({ timeout: 15_000 })

    // Not a dialog — vitals-section.tsx renders "Record new vitals" as a
    // plain inline form directly on the encounter page (a client component
    // using useActionState, not a modal), and "Record vitals" is only ever
    // the form's own submit button label.
    await page.getByLabel("Height (cm)").fill("165")
    await page.getByLabel("Weight (kg)").fill("60")
    await page.getByLabel("BP Systolic").fill("118")
    await page.getByLabel("BP Diastolic").fill("76")
    await page.getByLabel("Pulse (bpm)").fill("72")
    await page.getByLabel("Temp (°C)").fill("36.8")
    await page.getByLabel("SpO2 (%)").fill("98")
    await page.getByLabel("Resp. rate").fill("16")
    await page.getByRole("button", { name: "Record vitals" }).click()
    await expect(page.getByText(/^Latest ·/)).toBeVisible({ timeout: 10_000 })

    const vitals = await withDb((db) =>
      db.query<{ pulse_bpm: number; bmi: string | null }>(`select pulse_bpm, bmi from vital_sign where encounter_id=$1`, [encounterId])
    )
    expect(vitals.rows).toHaveLength(1)
    expect(vitals.rows[0].pulse_bpm).toBe(72)
    expect(vitals.rows[0].bmi, "BMI must be server-computed from height/weight, never left null when both are provided").not.toBeNull()

    patchFixture({ patients: { ...fixture.patients, aishaEncounterId: encounterId } })
  })

  test("add a diagnosis, place a lab order, and issue a prescription within the same encounter", async ({ page }) => {
    test.setTimeout(90_000)
    fixture = readFixture()
    encounterId = fixture.patients.aishaEncounterId
    await loginAsClinicUser(page, fixture.users.doctor1.email, fixture.users.doctor1.password)
    await page.goto(`/encounters/${encounterId}`)

    // Diagnosis.
    await page.getByRole("button", { name: "Add diagnosis" }).click()
    {
      const dlg = page.getByRole("dialog")
      await dlg.getByLabel("Description").fill("Upper respiratory tract infection — UAT synthetic diagnosis")
      const primary = dlg.getByRole("checkbox", { name: "Primary diagnosis" })
      if ((await primary.getAttribute("aria-checked")) !== "true") await primary.click()
      await dlg.getByRole("button", { name: "Add diagnosis" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })
    await expect(page.getByText(/Upper respiratory tract infection/)).toBeVisible({ timeout: 10_000 })

    // Lab order.
    await page.getByRole("button", { name: "Add order" }).click()
    {
      const dlg = page.getByRole("dialog")
      // orderType defaults to "lab" already.
      await dlg.getByLabel("Test name").fill(fixture.labTests.cbcName)
      await dlg.getByLabel("Specimen type").fill("Whole blood")
      await dlg.getByLabel("Reason / clinical notes").fill("Rule out infection — UAT synthetic order")
      await dlg.getByRole("button", { name: "Place order" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })

    // Prescription. NOT getByLabel — prescriptions-section.tsx's <Label>
    // elements have no htmlFor/id tying them to their <Input> (a real,
    // reportable a11y gap), so they're unreachable by accessible name.
    // Scoped by the field's own grid wrapper div instead.
    await page.getByRole("button", { name: "New prescription" }).click()
    {
      const dlg = page.getByRole("dialog")
      function field(label: string) {
        return dlg.locator("div.grid.gap-1", { hasText: label }).locator("input")
      }
      await field("Medication *").fill(fixture.medications.medAName)
      await field("Strength").fill("500mg")
      await field("Dose *").fill("1 tablet")
      await field("Frequency *").fill("Twice daily")
      await field("Route *").fill("Oral")
      await field("Duration (days)").fill("7")
      await field("Quantity").fill("14")
      await dlg.getByRole("button", { name: "Issue prescription" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })

    // Verify resulting database state for all three.
    const diag = await withDb((db) => db.query<{ count: string }>(`select count(*)::text from diagnosis where encounter_id=$1`, [encounterId]))
    expect(Number(diag.rows[0].count)).toBeGreaterThanOrEqual(1)
    const order = await withDb((db) =>
      db.query<{ count: string }>(`select count(*)::text from clinical_order where encounter_id=$1 and order_type='lab'`, [encounterId])
    )
    expect(Number(order.rows[0].count)).toBeGreaterThanOrEqual(1)
    const rx = await withDb((db) => db.query<{ count: string }>(`select count(*)::text from prescription where encounter_id=$1`, [encounterId]))
    expect(Number(rx.rows[0].count)).toBeGreaterThanOrEqual(1)

    const labOrder = await withDb((db) =>
      db.query<{ id: string }>(`select id from clinical_order where encounter_id=$1 and order_type='lab' order by ordered_at desc limit 1`, [encounterId])
    )
    const rxRow = await withDb((db) =>
      db.query<{ id: string }>(`select id from prescription where encounter_id=$1 order by issued_at desc limit 1`, [encounterId])
    )
    patchFixture({ patients: { ...fixture.patients, labOrderId: labOrder.rows[0].id, prescriptionId: rxRow.rows[0].id } })
  })

  test("finalize the encounter (complete → finalize), and verify a finalized encounter is never edited in place", async ({ page }) => {
    test.setTimeout(90_000)
    fixture = readFixture()
    encounterId = fixture.patients.aishaEncounterId
    await loginAsClinicUser(page, fixture.users.doctor1.email, fixture.users.doctor1.password)
    await page.goto(`/encounters/${encounterId}`)

    await page.getByRole("button", { name: "Complete encounter" }).click()
    await expect(page.getByRole("button", { name: "Finalize encounter" })).toBeVisible({ timeout: 15_000 })
    await page.getByRole("button", { name: "Finalize encounter" }).click()
    await expect(page.getByRole("button", { name: "Finalize encounter" })).toBeHidden({ timeout: 15_000 })

    const encounter = await withDb((db) => db.query<{ status: string }>(`select status from encounter where id=$1`, [encounterId]))
    expect(encounter.rows[0].status).toBe("finalized")

    // Once finalized, no in-place edit affordance should remain (Add
    // diagnosis / Add order / New prescription / Record vitals) — the
    // domain layer's own documented correction path is cancel/entered-in-error
    // or a NEW amendment row, never mutating the finalized record.
    for (const btn of ["Record vitals", "Add diagnosis", "Add order", "New prescription", "Complete encounter"]) {
      await expect(page.getByRole("button", { name: btn })).not.toBeVisible()
    }
  })
})
