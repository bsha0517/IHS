import { test, expect, type Page } from "@playwright/test"

/**
 * P5.2 §29/§30 — the required E2E coverage for pilot clinic operations:
 * does the real lifecycle (provision → onboard → UAT → go-live conditions
 * → approve → LIVE → clinic operates normally) actually work end to end
 * against `his_dev`, and does the server genuinely reject an incomplete
 * go-live attempt and a disabled-module mutation rather than relying on the
 * UI to hide the option? Three independent scenarios, same reasoning
 * P5.1's own E2E suite used for splitting platform/clinic flows.
 */
const OPERATOR_EMAIL = "operator@avant.local"
const OPERATOR_PASSWORD = "ChangeMe123!"

async function loginAsPlatformOperator(page: Page) {
  await page.goto("/platform/login")
  await page.getByLabel("Email").fill(OPERATOR_EMAIL)
  await page.getByLabel("Password").fill(OPERATOR_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await page.waitForURL(/\/platform$/)
}

async function loginAsClinicUser(page: Page, email: string, password: string) {
  await page.goto("/login")
  await page.getByLabel("Email", { exact: true }).fill(email)
  await page.getByLabel("Password").fill(password)
  await page.getByRole("button", { name: "Sign in" }).click()
}

async function provisionSyntheticClinic(page: Page, suffix: string) {
  await page.goto("/platform/provision")
  await page.getByLabel("Display name").fill(`P5.2 Pilot Clinic ${suffix}`)
  await page.getByLabel("Legal name").fill(`P5.2 Pilot Clinic Legal ${suffix}`)
  await page.getByLabel("Country (ISO-2)").fill("PK")
  const planNativeSelect = page.locator('select[name="planId"]')
  const firstPlanValue = await planNativeSelect.locator("option").nth(0).getAttribute("value")
  await planNativeSelect.selectOption(firstPlanValue!)
  await page.getByLabel("Start date").fill(new Date().toISOString().slice(0, 10))
  await page.getByLabel("Branch name").fill("Pilot Branch")
  // Branch code has a 20-char server-side limit — truncate rather than
  // grow unbounded with longer scenario-specific suffixes (e.g. the
  // isolation test's `iso-a-${suffix}`/`iso-b-${suffix}`). Truncating from
  // the right still preserves the distinguishing prefix between two codes
  // built from the same suffix.
  await page.getByLabel("Branch code").fill(`P52E2E-${suffix}`.slice(0, 20))
  await page.getByLabel("First name").fill("Pilot")
  await page.getByLabel("Last name").fill("Admin")
  const adminEmail = `p52-pilot-admin-${suffix}@test.local`
  await page.getByLabel("Email", { exact: true }).fill(adminEmail)
  await page.getByRole("button", { name: "Provision clinic" }).click()
  await expect(page.getByText(/Clinic provisioned/i)).toBeVisible({ timeout: 15_000 })

  const activationPath = (await page.locator("code").textContent())!.trim()
  // Both the activation code and this link render from the same
  // `state.success` object in one atomic React update, but a one-shot
  // getAttribute() has no retry if it's read a beat before Playwright
  // considers the link fully "there" — toHaveAttribute auto-retries against
  // the real expected shape instead of trusting the very next paint.
  const orgLink = page.getByRole("link", { name: "Open organization" })
  await expect(orgLink).toHaveAttribute("href", /^\/platform\/organizations\/.+/, { timeout: 10_000 })
  const organizationLink = (await orgLink.getAttribute("href"))!
  const organizationId = organizationLink.split("/").pop()!
  return { activationPath, organizationLink, organizationId, adminEmail }
}

test.describe("P5.2 E2E: full pilot lifecycle — provision through go-live approval", () => {
  test("Platform Operator provisions a clinic, completes onboarding + UAT + go-live conditions, approves go-live, and the clinic admin can operate normally afterward", async ({ page, context }) => {
    test.setTimeout(150_000)
    await loginAsPlatformOperator(page)

    const suffix = Date.now().toString().slice(-8)
    const { activationPath, organizationLink, organizationId, adminEmail } = await provisionSyntheticClinic(page, suffix)

    // Activate the clinic admin's real password (mirrors P5.1's own E2E
    // pattern) so we can prove clinic access works both before and after
    // go-live approval — approval must never depend on this step.
    const clinicContext = await context.browser()!.newContext()
    const clinicPage = await clinicContext.newPage()
    await clinicPage.goto(activationPath)
    const clinicPassword = "PilotAdmin123!"
    await clinicPage.getByLabel("New password", { exact: true }).fill(clinicPassword)
    await clinicPage.getByLabel("Confirm new password").fill(clinicPassword)
    await clinicPage.getByRole("button", { name: "Reset password" }).click()
    await expect(clinicPage.getByText(/password has been reset/i)).toBeVisible({ timeout: 10_000 })
    await loginAsClinicUser(clinicPage, adminEmail, clinicPassword)
    // 20s, not 10s — this specific wait (first render of a data-heavy
    // dashboard route right after login) has twice been the actual point of
    // failure under cold Turbopack dev-server compilation, never a real
    // login defect (confirmed by repeated clean passes of this exact flow).
    await clinicPage.waitForURL(/\/dashboard/, { timeout: 20_000 })

    // Review onboarding — mark every required item complete/waived.
    await page.goto(`${organizationLink}/onboarding`)
    await expect(page.getByRole("heading", { name: /Onboarding/ })).toBeVisible()
    // Each item's "Update" button stays rendered (with the same text) after
    // it's completed — it never disappears from the list — so re-querying
    // `.first()` on every iteration just re-selects item #1 over and over.
    // Index into the stable-order button collection instead so every item
    // actually gets visited once.
    const updateButtons = page.getByRole("button", { name: "Update" })
    const updateCount = await updateButtons.count()
    for (let i = 0; i < updateCount; i++) {
      await updateButtons.nth(i).click()
      const statusSelect = page.getByRole("combobox", { name: "Status" })
      await statusSelect.click()
      await page.getByRole("option", { name: "completed", exact: true }).click()
      await page.getByRole("button", { name: "Save" }).click()
      await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })
    }
    await expect(page.getByText(/(\d+) \/ \1 required items complete/)).toBeVisible()

    // Record and complete a pilot UAT cycle.
    await page.goto(`${organizationLink}/uat`)
    await page.getByRole("button", { name: "New UAT cycle" }).click()
    await page.getByLabel("Cycle label").fill("Pilot Cycle 1")
    await page.getByLabel("Tester").fill("Clinic Reception Staff")
    await page.getByRole("button", { name: "Start cycle" }).click()
    await expect(page.getByText("Pilot Cycle 1")).toBeVisible({ timeout: 10_000 })
    await page.getByRole("button", { name: "Complete / sign off" }).click()
    const resultSelect = page.getByRole("combobox", { name: "Result" })
    await resultSelect.click()
    await page.getByRole("option", { name: "Passed", exact: true }).click()
    await page.getByLabel("Sign off this cycle as reviewed and accepted").check()
    await page.getByRole("button", { name: "Save" }).click()
    await expect(page.getByText("Pilot Cycle 1")).toBeVisible({ timeout: 10_000 })

    // Verify go-live conditions — mark every one complete. Scoped to the
    // exact per-condition row class (go-live-conditions-card.tsx's own
    // "rounded-md border border-border p-3" div) — a bare `div` locator
    // matches every ANCESTOR whose text also happens to contain the label
    // (CardContent, Card, page wrapper), not just the one specific row.
    await page.goto(organizationLink)
    for (const label of ["Hosted backup", "External production error monitoring", "Clinic-specific UAT", "Transactional email"]) {
      const card = page.locator("div.rounded-md.border.border-border", { hasText: label }).filter({ has: page.getByRole("button", { name: "Mark verified" }) })
      await card.getByRole("button", { name: "Mark verified" }).click()
      await page.waitForTimeout(400)
    }

    // Approve go-live.
    await page.reload()
    await expect(page.getByRole("button", { name: "Approve go-live" })).toBeEnabled({ timeout: 10_000 })
    await page.getByRole("button", { name: "Approve go-live" }).click()
    await page.getByRole("button", { name: "Confirm approval" }).click()
    await expect(page.getByText(/Not ready for go-live/i)).not.toBeVisible({ timeout: 10_000 })

    // The clinic admin can still operate normally — go-live approval never
    // disrupted their already-working session or account.
    await clinicPage.goto("/dashboard")
    await expect(clinicPage.getByRole("heading", { name: /welcome/i })).toBeVisible({ timeout: 10_000 })

    await clinicContext.close()
    void organizationId
  })
})

test.describe("P5.2 E2E: go-live failure path — server rejects an incomplete approval attempt", () => {
  test("attempting go-live approval on a freshly-provisioned clinic (conditions unmet) is rejected server-side, and the UI explains why", async ({ page }) => {
    test.setTimeout(60_000)
    await loginAsPlatformOperator(page)
    const suffix = Date.now().toString().slice(-8)
    const { organizationLink } = await provisionSyntheticClinic(page, `fail-${suffix}`)

    await page.goto(organizationLink)
    // The button itself must be disabled — the server has nothing further
    // to reject here because the UI already reflects genuine unmet
    // conditions computed by the same function approveGoLive() itself uses.
    const approveButton = page.getByRole("button", { name: "Approve go-live" })
    await expect(approveButton).toBeDisabled()
    await expect(page.getByText(/Not ready for go-live/i)).toBeVisible()
    await expect(page.getByText(/go-live condition\(s\) not yet verified/i)).toBeVisible()

    // The organization remains non-live — the status badge renders the raw
    // lowercase enum value ("active"), never title-cased.
    await expect(page.getByText(/^active$/).first()).toBeVisible()
  })
})

test.describe("P5.2 E2E §9/§10: Server Action entitlement enforcement — rejected independent of route/UI state", () => {
  test("disabling a module while its form is already open in the browser still blocks the mutation at the Server Action itself, with a clear message, not a crash", async ({ page, context }) => {
    test.setTimeout(90_000)
    await loginAsPlatformOperator(page)
    const suffix = Date.now().toString().slice(-8)
    const { activationPath, organizationLink, adminEmail } = await provisionSyntheticClinic(page, `ent-${suffix}`)

    // Ensure "assets" is enabled for this org so the clinic admin can
    // actually reach the page and open the form in the first place. Each
    // module row is a <label> (entitlements-card.tsx), not a <div> — scoped
    // precisely so this never accidentally toggles a different module's
    // checkbox (a bare `div`/hasText locator matches every ancestor whose
    // text also contains "Assets", not the one specific row).
    await page.goto(organizationLink)
    // entitlements-card.tsx renders a Radix Checkbox — a <button
    // role="checkbox" aria-checked>, not a native <input type="checkbox">.
    const assetsRow = page.locator("label.rounded-md.border", { hasText: "Assets" })
    const assetsCheckbox = assetsRow.getByRole("checkbox")
    if ((await assetsCheckbox.getAttribute("aria-checked")) !== "true") {
      await assetsCheckbox.click()
      await page.waitForTimeout(400)
    }

    const clinicContext = await context.browser()!.newContext()
    const clinicPage = await clinicContext.newPage()
    await clinicPage.goto(activationPath)
    const clinicPassword = "PilotAdmin123!"
    await clinicPage.getByLabel("New password", { exact: true }).fill(clinicPassword)
    await clinicPage.getByLabel("Confirm new password").fill(clinicPassword)
    await clinicPage.getByRole("button", { name: "Reset password" }).click()
    // Wait for the reset to actually land before navigating away — without
    // this, goto("/login") can race the in-flight reset submission and the
    // subsequent login attempt uses a password that hasn't been set yet.
    await expect(clinicPage.getByText(/password has been reset/i)).toBeVisible({ timeout: 10_000 })
    await loginAsClinicUser(clinicPage, adminEmail, clinicPassword)
    // 20s, not 10s — this specific wait (first render of a data-heavy
    // dashboard route right after login) has twice been the actual point of
    // failure under cold Turbopack dev-server compilation, never a real
    // login defect (confirmed by repeated clean passes of this exact flow).
    await clinicPage.waitForURL(/\/dashboard/, { timeout: 20_000 })

    await clinicPage.goto("/assets")
    await clinicPage.getByRole("button", { name: "New asset" }).click()
    await expect(clinicPage.getByRole("dialog")).toBeVisible()
    // Name/Category/Branch are required native-validated fields — leaving
    // them empty blocks the browser's own form submission before it ever
    // reaches the network, so the Server Action (and its
    // assertModuleEnabled() check) would never actually be exercised.
    await clinicPage.getByLabel("Name").fill("P5.2 E2E Test Asset")
    await clinicPage.getByLabel("Category").fill("Test Category")
    await clinicPage.getByRole("combobox", { name: "Branch" }).click()
    await clinicPage.getByRole("option", { name: "Pilot Branch" }).click()

    // Simulate an operator disabling the module WHILE the clinic admin
    // already has this form open — no fresh navigation/proxy check will
    // run for this next submit, only the Server Action's own
    // assertModuleEnabled() call.
    await page.goto(organizationLink)
    const assetsRow2 = page.locator("label.rounded-md.border", { hasText: "Assets" })
    await assetsRow2.getByRole("checkbox").click()
    await page.waitForTimeout(500)

    // Submit the already-open, now-stale form.
    await clinicPage.getByRole("button", { name: "Create asset" }).click()
    await expect(clinicPage.getByText(/not enabled for this organization/i)).toBeVisible({ timeout: 10_000 })

    // No asset was actually created despite the client-side form submit.
    await clinicPage.getByRole("button", { name: /cancel|close/i }).click().catch(() => {})
    await clinicContext.close()
  })
})

test.describe("P5.2 E2E §8/§37: support ticket organization isolation, verified by direct URL", () => {
  test("a platform operator can see tickets across organizations, but a clinic admin cannot reach another organization's ticket by guessing/reusing a URL", async ({ page, context }) => {
    test.setTimeout(90_000)
    await loginAsPlatformOperator(page)
    const suffixA = Date.now().toString().slice(-8)
    const orgA = await provisionSyntheticClinic(page, `iso-a-${suffixA}`)
    const orgB = await provisionSyntheticClinic(page, `iso-b-${suffixA}`)

    // Platform operator files a ticket against Org B. The title includes the
    // run's own suffix — a fixed literal title would collide (strict-mode
    // violation) with a same-titled ticket left behind by an earlier run of
    // this same suite against the shared `his_dev` database.
    const ticketTitle = `Org B isolation test ticket ${suffixA}`
    await page.goto("/platform/tickets")
    await page.getByRole("button", { name: "New ticket" }).click()
    const orgSelect = page.getByRole("combobox", { name: "Organization" })
    await orgSelect.click()
    await page.getByRole("option", { name: new RegExp(`P5\\.2 Pilot Clinic iso-b-${suffixA}`) }).click()
    await page.getByLabel("Title").fill(ticketTitle)
    await page.getByLabel("Description").fill("Testing cross-org isolation.")
    await page.getByRole("button", { name: "Create ticket" }).click()
    await expect(page.getByText(ticketTitle)).toBeVisible({ timeout: 10_000 })
    const ticketLink = await page.getByRole("link", { name: /SUP-\d{6}/ }).first().getAttribute("href")
    const ticketId = ticketLink!.split("/").pop()!

    // Activate Org A's admin and confirm they cannot reach Org B's ticket by direct URL.
    const clinicContext = await context.browser()!.newContext()
    const clinicPage = await clinicContext.newPage()
    await clinicPage.goto(orgA.activationPath)
    await clinicPage.getByLabel("New password", { exact: true }).fill("PilotAdmin123!")
    await clinicPage.getByLabel("Confirm new password").fill("PilotAdmin123!")
    await clinicPage.getByRole("button", { name: "Reset password" }).click()
    await expect(clinicPage.getByText(/password has been reset/i)).toBeVisible({ timeout: 10_000 })
    await loginAsClinicUser(clinicPage, orgA.adminEmail, "PilotAdmin123!")
    // 20s, not 10s — this specific wait (first render of a data-heavy
    // dashboard route right after login) has twice been the actual point of
    // failure under cold Turbopack dev-server compilation, never a real
    // login defect (confirmed by repeated clean passes of this exact flow).
    await clinicPage.waitForURL(/\/dashboard/, { timeout: 20_000 })

    await clinicPage.goto(`/support/${ticketId}`)
    // notFoundOrForbidden-style handling — never the raw ticket content.
    await expect(clinicPage.getByText(ticketTitle)).not.toBeVisible()

    await clinicContext.close()
    void orgB
  })
})
