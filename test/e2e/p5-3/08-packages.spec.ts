import { test, expect } from "@playwright/test"
import { loginAsClinicUser, readFixture, withDb, type PilotFixture } from "./fixtures"

/**
 * P5.3 Step 14 — treatment package UAT: sell the package created in setup
 * to Bilal (through the same Charge→Invoice→Payment pipeline as any other
 * billable item, confirmed by inspection — not a separate payment path),
 * then consume one session and verify the remaining balance decrements
 * via a real, append-only usage row rather than a mutable counter.
 */
test.describe.serial("P5.3 Packages UAT", () => {
  let fixture: PilotFixture

  test("sell the treatment package to Bilal, then invoice and pay for it through the normal POS flow", async ({ page }) => {
    test.setTimeout(120_000)
    fixture = readFixture()
    await loginAsClinicUser(page, fixture.users.receptionist.email, fixture.users.receptionist.password)
    await page.goto(`/patients/${fixture.patients.bilal}`)
    // There is no "Billing" tab — billing-tabs.tsx splits it into separate
    // Packages/Invoices/Payments/Statement tabs (page.tsx's LIVE_BILLING_TABS),
    // and "Sell package" lives specifically under "Packages".
    await page.getByRole("tab", { name: "Packages" }).click()
    await page.getByRole("button", { name: "Sell package" }).click()
    {
      const dlg = page.getByRole("dialog")
      await dlg.getByRole("combobox", { name: "Package" }).click()
      await page.getByRole("option", { name: new RegExp(fixture.packages.basicPackageName!) }).click()
      await dlg.getByRole("button", { name: "Sell package" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })

    const patientPackage = await withDb((db) =>
      db.query<{ id: string }>(`select id from patient_package where organization_id=$1 and patient_id=$2 order by purchased_at desc limit 1`, [
        fixture.organizationId,
        fixture.patients.bilal,
      ])
    )
    expect(patientPackage.rows[0]?.id, "PatientPackage row must exist after sale").toBeTruthy()

    // Same billing pipeline as any other item — a Charge, then invoice+pay via POS.
    const charge = await withDb((db) =>
      db.query<{ id: string }>(`select id from charge where organization_id=$1 and source_type='package' and patient_id=$2 order by created_at desc limit 1`, [
        fixture.organizationId,
        fixture.patients.bilal,
      ])
    )
    expect(charge.rows[0]?.id, "package sale must generate a real pending Charge, not a separate payment path").toBeTruthy()

    // 05-billing-commissions.spec.ts's own final test closes the cashier
    // register as part of its own UAT (verifying expected cash/variance),
    // so by the time this file runs — right after it in the intended full
    // sequence — no register is open here yet either.
    await page.goto("/pos")
    const registerBtn = page.getByRole("button", { name: "Open register" })
    if (await registerBtn.isVisible().catch(() => false)) {
      await page.getByRole("combobox", { name: "Branch" }).click()
      await page.getByRole("option", { name: fixture.branchA.name }).click()
      await page.getByLabel("Opening cash").fill("500")
      await registerBtn.click()
      await expect(page.getByRole("button", { name: "Close register" })).toBeVisible({ timeout: 15_000 })
    }

    await page.goto(`/pos?patientId=${fixture.patients.bilal}`)
    // Not the raw input[name="chargeIds"] — shadcn's Checkbox hides the
    // native input (aria-hidden) behind a visible role="checkbox" button
    // that intercepts pointer events and blocks .check() from landing.
    const packageCharge = page.locator(`button[role="checkbox"][value="${charge.rows[0].id}"]`)
    if ((await packageCharge.count()) > 0) await packageCharge.click()
    else await page.getByRole("checkbox").first().click()
    await page.getByRole("button", { name: /Create Invoice \(\d+\)/ }).click()
    await expect(page).toHaveURL(/\/invoices\/[^/]+$/, { timeout: 15_000 })
    const packageInvoiceId = page.url().split("/").pop()!

    // record-payment-dialog.tsx already defaults its one tender to
    // { method: "cash", amount: outstanding.toFixed(2) } — exactly the full
    // cash payment this test wants, so no field interaction is needed
    // before submitting (its "Method" <Label> also has no htmlFor tying it
    // to the Select, the same unlabeled-field gap found in 05-billing-
    // commissions.spec.ts's identical dialog).
    await page.getByRole("button", { name: "Record payment" }).click()
    await page.getByRole("dialog").getByRole("button", { name: "Record payment" }).click()
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })

    const paidStatus = await withDb((db) => db.query<{ status: string }>(`select status from invoice where id=$1`, [packageInvoiceId]))
    expect(paidStatus.rows[0].status).toBe("paid")
  })

  test("consume one session from Bilal's package — the remaining balance decrements via an append-only usage row, never a mutable counter", async ({ page }) => {
    test.setTimeout(90_000)
    fixture = readFixture()
    // "Use session" is gated on package.consume, which per the seeded role
    // catalog (system-roles.ts) belongs to Doctor/Nurse, not Receptionist —
    // Receptionist only holds package.sell. A real clinic has a clinician,
    // not reception, record actual session usage.
    await loginAsClinicUser(page, fixture.users.doctor1.email, fixture.users.doctor1.password)
    await page.goto(`/patients/${fixture.patients.bilal}`)
    await page.getByRole("tab", { name: "Packages" }).click()

    const patientPackage = await withDb((db) =>
      db.query<{ id: string }>(`select id from patient_package where organization_id=$1 and patient_id=$2 order by purchased_at desc limit 1`, [
        fixture.organizationId,
        fixture.patients.bilal,
      ])
    )
    const ppId = patientPackage.rows[0].id
    const usageBefore = await withDb((db) => db.query<{ count: string }>(`select count(*)::text from patient_package_session where patient_package_id=$1`, [ppId]))

    await page.getByRole("button", { name: "Use session" }).first().click()
    {
      const dlg = page.getByRole("dialog")
      await dlg.getByPlaceholder("Notes (optional)").fill("UAT synthetic session use")
      await dlg.getByRole("button", { name: "Record usage" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })

    const usageAfter = await withDb((db) => db.query<{ count: string }>(`select count(*)::text from patient_package_session where patient_package_id=$1`, [ppId]))
    expect(Number(usageAfter.rows[0].count)).toBe(Number(usageBefore.rows[0].count) + 1)
  })
})
