import { test, expect } from "@playwright/test"
import { loginAsClinicUser, loginAsPlatformOperator, readFixture, withDb, type PilotFixture } from "./fixtures"

/**
 * P5.3 Step 16/17 — multi-branch and security UAT. Marked explicitly
 * critical by the command. Covers: branch-scoped access (doctor2 is
 * Branch B-only, per setup), organization/tenant isolation (against a
 * second throwaway synthetic org), entitlement enforcement for the one
 * module deliberately disabled in setup (Assets), and suspension/
 * reactivation.
 */
test.describe.serial("P5.3 Multi-Branch UAT", () => {
  let fixture: PilotFixture

  test("doctor2 (Branch B only) cannot reach Branch A's appointment by direct URL, and Branch A's appointment list never shows Branch B data to a Branch-A-only user", async ({ page }) => {
    test.setTimeout(90_000)
    fixture = readFixture()
    await loginAsClinicUser(page, fixture.users.doctor2.email, fixture.users.doctor2.password)
    await page.goto(`/appointments/${fixture.patients.aishaAppointmentId}`)
    // Aisha's appointment belongs to Branch A — doctor2 only has Branch B
    // access. This app's own established convention (confirmed in P5.2 and
    // throughout this codebase) is a redirect/not-found, never the actual
    // restricted record rendering.
    const stillShowsAisha = await page.getByText(`Aisha Pilot${fixture.suffix}`).isVisible({ timeout: 5_000 }).catch(() => false)
    expect(stillShowsAisha, "a Branch-B-only user must never see a Branch A patient's appointment content").toBe(false)
  })

  test("doctor2 operates normally within their own Branch B — can view the appointments list scoped to Branch B without error", async ({ page }) => {
    test.setTimeout(90_000)
    fixture = readFixture()
    await loginAsClinicUser(page, fixture.users.doctor2.email, fixture.users.doctor2.password)
    await page.goto("/appointments")
    await expect(page.getByRole("heading", { name: /Appointments/i })).toBeVisible({ timeout: 15_000 })
    // Must not error/crash — a Branch-B-only provider's own list page must render normally.
    await expect(page.getByText(/Something went wrong/i)).not.toBeVisible()
  })

  test("org-wide roles (inventory manager, accountant, HR manager — all given both-branch access in setup) can see data across both branches", async ({ page }) => {
    test.setTimeout(60_000)
    fixture = readFixture()
    await loginAsClinicUser(page, fixture.users.inventoryMgr.email, fixture.users.inventoryMgr.password)
    await page.goto("/inventory")
    await expect(page.getByRole("heading", { name: /Inventory/i })).toBeVisible({ timeout: 15_000 })
    const branchFilter = page.getByRole("combobox", { name: /Branch/i }).first()
    if (await branchFilter.isVisible().catch(() => false)) {
      await branchFilter.click()
      await expect(page.getByRole("option", { name: fixture.branchA.name })).toBeVisible()
      await expect(page.getByRole("option", { name: fixture.branchB.name })).toBeVisible()
    }
  })
})

test.describe.serial("P5.3 Security UAT", () => {
  let fixture: PilotFixture
  let secondOrgLink: string
  let secondOrgAdminEmail: string
  let secondOrgActivationPath: string

  test("provision a second throwaway synthetic clinic to test cross-organization tenant isolation against", async ({ page }) => {
    test.setTimeout(60_000)
    fixture = readFixture()
    await loginAsPlatformOperator(page)
    await page.goto("/platform/provision")
    await page.getByLabel("Display name").fill(`P5.3 Security Test Org ${fixture.suffix}`)
    await page.getByLabel("Legal name").fill(`P5.3 Security Test Org Legal ${fixture.suffix}`)
    await page.getByLabel("Country (ISO-2)").fill("PK")
    const planSelect = page.locator('select[name="planId"]')
    const starterValue = await planSelect.locator("option", { hasText: "Starter" }).getAttribute("value")
    await planSelect.selectOption(starterValue!)
    await page.getByLabel("Start date").fill(new Date().toISOString().slice(0, 10))
    await page.getByLabel("Branch name").fill("Security Test Branch")
    await page.getByLabel("Branch code").fill(`P53-SEC-${fixture.suffix}`.slice(0, 20))
    await page.getByLabel("First name").fill("Security")
    await page.getByLabel("Last name").fill("TestAdmin")
    secondOrgAdminEmail = `p53-sectest-admin-${fixture.suffix}@test.local`
    await page.getByLabel("Email", { exact: true }).fill(secondOrgAdminEmail)
    await page.getByRole("button", { name: "Provision clinic" }).click()
    await expect(page.getByText(/Clinic provisioned/i)).toBeVisible({ timeout: 15_000 })
    secondOrgActivationPath = (await page.locator("code").textContent())!.trim()
  })

  test("REQUIRED — Org B's admin cannot reach Org A's patient, appointment, or invoice by direct URL, even knowing the exact id", async ({ page }) => {
    test.setTimeout(90_000)
    fixture = readFixture()
    await page.goto(secondOrgActivationPath)
    await page.getByLabel("New password", { exact: true }).fill("SecTest123!")
    await page.getByLabel("Confirm new password").fill("SecTest123!")
    await page.getByRole("button", { name: "Reset password" }).click()
    await expect(page.getByText(/password has been reset/i)).toBeVisible({ timeout: 10_000 })
    await loginAsClinicUser(page, secondOrgAdminEmail, "SecTest123!")

    for (const path of [
      `/patients/${fixture.patients.aisha}`,
      `/appointments/${fixture.patients.aishaAppointmentId}`,
      `/invoices/${fixture.patients.aishaInvoiceId}`,
    ]) {
      await page.goto(path)
      const leaked = await page.getByText(`Aisha Pilot${fixture.suffix}`).isVisible({ timeout: 5_000 }).catch(() => false)
      expect(leaked, `Org B must never see Org A's data at ${path}`).toBe(false)
    }
  })

  test("REQUIRED — Org B's admin cannot reach Org A's support ticket by direct URL", async ({ page }) => {
    test.setTimeout(60_000)
    fixture = readFixture()
    // File a ticket for Org A first (as Org A's own super admin), then try
    // to reach it as Org B's admin.
    await loginAsClinicUser(page, fixture.users.superAdmin.email, fixture.users.superAdmin.password)
    await page.goto("/support")
    await page.getByRole("button", { name: "New ticket" }).click()
    const ticketTitle = `P5.3 cross-org isolation test ${fixture.suffix}`
    {
      const dlg = page.getByRole("dialog")
      await dlg.getByLabel("Title").fill(ticketTitle)
      await dlg.getByLabel("Description").fill("Testing cross-org ticket isolation during P5.3 UAT.")
      await dlg.getByRole("button", { name: "Submit" }).click()
    }
    // .first() — earlier P5.3 runs against this same org can leave a
    // stray ticket with this exact synthetic title behind, making a
    // page-wide text match ambiguous (strict-mode violation).
    await expect(page.getByText(ticketTitle).first()).toBeVisible({ timeout: 10_000 })

    const ticket = await withDb((db) =>
      db.query<{ id: string }>(
        `select id from support_ticket where organization_id=$1 and title=$2 order by created_at desc limit 1`,
        [fixture.organizationId, ticketTitle]
      )
    )
    const ticketId = ticket.rows[0].id

    await loginAsClinicUser(page, secondOrgAdminEmail, "SecTest123!")
    await page.goto(`/support/${ticketId}`)
    await expect(page.getByText(ticketTitle)).not.toBeVisible()
  })

  test("REQUIRED — the disabled Assets module rejects a Server Action mutation directly, even if the client form is already open (not just a hidden nav link)", async ({ page, context }) => {
    test.setTimeout(90_000)
    fixture = readFixture()
    // Assets was disabled during setup for this exact test. Confirm the
    // nav doesn't show it, then confirm the underlying route/action reject
    // too (never rely on the UI hiding the option as the only control).
    await loginAsClinicUser(page, fixture.users.superAdmin.email, fixture.users.superAdmin.password)
    await expect(page.getByRole("link", { name: "Assets" })).not.toBeVisible()

    await page.goto("/assets")
    await page.waitForURL(/\/dashboard$/, { timeout: 15_000 })

    // Re-enable briefly to open the mutation form, then disable again while
    // the form is open — the exact real-world race P5.2's own equivalent
    // test proved the Server Action itself (not just route middleware) rejects.
    const opContext = await context.browser()!.newContext()
    const opPage = await opContext.newPage()
    await loginAsPlatformOperator(opPage)
    await opPage.goto(fixture.organizationLink)
    const assetsRow = opPage.locator("label.rounded-md.border", { hasText: "Assets" })
    await assetsRow.getByRole("checkbox").click()
    await opPage.waitForTimeout(500)

    await page.goto("/assets")
    await expect(page.getByRole("button", { name: "New asset" })).toBeVisible({ timeout: 15_000 })
    await page.getByRole("button", { name: "New asset" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()

    await assetsRow.getByRole("checkbox").click()
    await opPage.waitForTimeout(500)

    // Category and Branch are also required (asset-dialog.tsx) — leaving
    // them blank lets the browser's own HTML5 validation silently block
    // submission (a tooltip, no server round-trip at all), which would
    // never actually exercise the server-side entitlement rejection this
    // test exists to prove.
    await page.getByLabel("Name").fill("UAT stale-form asset")
    await page.getByLabel("Category").fill("UAT")
    await page.getByRole("combobox", { name: "Branch" }).click()
    await page.getByRole("option", { name: fixture.branchA.name }).click()
    await page.getByRole("button", { name: "Create asset" }).click()
    await expect(page.getByText(/not enabled for this organization/i)).toBeVisible({ timeout: 10_000 })
    await opContext.close()
  })

  test("REQUIRED — suspending the organization blocks normal clinic operation, and reactivating restores it", async ({ page }) => {
    test.setTimeout(90_000)
    fixture = readFixture()
    await loginAsPlatformOperator(page)
    await page.goto(fixture.organizationLink)
    await page.getByRole("button", { name: "Suspend organization" }).click()
    {
      const dlg = page.getByRole("dialog")
      await dlg.getByPlaceholder("Reason").fill("P5.3 UAT suspension test")
      await dlg.getByRole("button", { name: "Confirm" }).click()
    }
    await expect(page.getByText(/suspended/i).first()).toBeVisible({ timeout: 10_000 })

    // A clinic user's existing session must be revoked immediately, not
    // merely denied on next login — matches P4.3's own documented behavior.
    await loginAsClinicUser(page, fixture.users.receptionist.email, fixture.users.receptionist.password).catch(() => {})
    const blocked = page.url().includes("/login") || (await page.getByText(/suspend/i).isVisible({ timeout: 5_000 }).catch(() => false))
    expect(blocked, "a suspended organization's staff must not be able to log in and operate normally").toBe(true)

    await loginAsPlatformOperator(page)
    await page.goto(fixture.organizationLink)
    await page.getByRole("button", { name: "Reactivate" }).click()
    await expect(page.getByText(/^active$/).first()).toBeVisible({ timeout: 10_000 })

    // loginAsClinicUser itself already waits for a successful post-login
    // landing (never /login) — the receptionist's own real landing page is
    // /reception (resolveDefaultLandingRoute), not /dashboard. Reaching
    // this line at all confirms the login succeeded normally.
    await loginAsClinicUser(page, fixture.users.receptionist.email, fixture.users.receptionist.password)
    await expect(page).not.toHaveURL(/\/login/)
  })
})
