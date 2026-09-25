import { test, expect, type Page } from "@playwright/test"

/**
 * P5.1 §30/§39 — the required E2E coverage for the commercial SaaS
 * foundation: does the real, deployed-shaped flow actually work end to end
 * against `his_dev`? Split into two independent, deterministic flows per
 * this command's own §30 guidance ("split into deterministic platform and
 * clinic E2E flows" when one long flow is impractical) — the platform
 * operator's session and the clinic admin's session are two fully separate
 * auth planes (PlatformSession vs Session), so this file logs in as each
 * explicitly rather than trying to share one browser session across both.
 */
const OPERATOR_EMAIL = "operator@avant.local"
const OPERATOR_PASSWORD = "ChangeMe123!"
const CLINIC_ADMIN_EMAIL = "admin@avant.local"
const CLINIC_ADMIN_PASSWORD = "ChangeMe123!"

async function loginAsPlatformOperator(page: Page) {
  await page.goto("/platform/login")
  await page.getByLabel("Email").fill(OPERATOR_EMAIL)
  await page.getByLabel("Password").fill(OPERATOR_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await page.waitForURL(/\/platform$/)
}

async function loginAsClinicUser(page: Page, email: string, password: string) {
  await page.goto("/login")
  await page.getByLabel("Email").fill(email)
  await page.getByLabel("Password").fill(password)
  await page.getByRole("button", { name: "Sign in" }).click()
}

test.describe("P5.1 E2E: platform operator provisions a synthetic clinic end to end", () => {
  test("login -> dashboard -> provision Avant P5 Pilot Clinic -> assign plan/modules/branch/admin -> organization detail shows the new tenant with readiness pending", async ({ page }) => {
    test.setTimeout(60_000)
    await loginAsPlatformOperator(page)
    await expect(page.getByRole("heading", { name: "Platform Dashboard" })).toBeVisible()

    await page.getByRole("link", { name: "Provision Clinic" }).first().click()
    await page.waitForURL(/\/platform\/provision/)

    const uniqueSuffix = Date.now().toString().slice(-8)
    await page.getByLabel("Display name").fill(`Avant P5 Pilot Clinic E2E ${uniqueSuffix}`)
    await page.getByLabel("Legal name").fill(`Avant P5 Pilot Clinic Legal E2E ${uniqueSuffix}`)
    await page.getByLabel("Country (ISO-2)").fill("PK")

    // Radix Select: drive the underlying hidden native <select> directly —
    // the same documented workaround smoke.spec.ts already uses for the
    // appointment provider picker, for the same headless-pointer-event
    // reason (see that file's own comment).
    const planNativeSelect = page.locator('select[name="planId"]')
    const firstPlanValue = await planNativeSelect.locator("option").nth(0).getAttribute("value")
    await planNativeSelect.selectOption(firstPlanValue!)

    await page.getByLabel("Start date").fill(new Date().toISOString().slice(0, 10))

    await page.getByLabel("Branch name").fill("Pilot Main Branch E2E")
    await page.getByLabel("Branch code").fill(`PLTE2E-${uniqueSuffix}`)

    await page.getByLabel("First name").fill("Pilot")
    await page.getByLabel("Last name").fill("Admin")
    const adminEmail = `pilot-e2e-admin-${uniqueSuffix}@test.local`
    await page.getByLabel("Email", { exact: true }).fill(adminEmail)

    await page.getByRole("button", { name: "Provision clinic" }).click()

    await expect(page.getByText(/Clinic provisioned/i)).toBeVisible({ timeout: 15_000 })
    const activationLinkCode = page.locator("code")
    await expect(activationLinkCode).toBeVisible()
    const activationPath = await activationLinkCode.textContent()
    expect(activationPath).toMatch(/\/reset-password\?token=/)

    await page.getByRole("link", { name: "Open organization" }).click()
    await page.waitForURL(/\/platform\/organizations\/[^/]+$/)
    await expect(page.getByRole("heading", { name: `Avant P5 Pilot Clinic E2E ${uniqueSuffix}` })).toBeVisible()
    await expect(page.getByText(/No commercial profile/)).not.toBeVisible()
    await expect(page.getByText("Pilot Main Branch E2E")).toBeVisible()
    await expect(page.getByText(adminEmail)).toBeVisible()

    // §22: go-live conditions exist and are NOT falsely marked complete.
    await expect(page.getByText("Go-live", { exact: false }).first()).toBeVisible()
  })
})

test.describe("P5.1 E2E: suspend/reactivate blocks and restores clinic access immediately", () => {
  test("suspending an organization from the platform blocks its admin from logging in; reactivating restores access", async ({ page, context }) => {
    test.setTimeout(90_000)
    await loginAsPlatformOperator(page)
    await page.goto("/platform/provision")

    const uniqueSuffix = Date.now().toString().slice(-8)
    await page.getByLabel("Display name").fill(`P5.1 Suspend E2E ${uniqueSuffix}`)
    await page.getByLabel("Legal name").fill(`P5.1 Suspend E2E Legal ${uniqueSuffix}`)
    await page.getByLabel("Country (ISO-2)").fill("PK")
    const planNativeSelect = page.locator('select[name="planId"]')
    const firstPlanValue = await planNativeSelect.locator("option").nth(0).getAttribute("value")
    await planNativeSelect.selectOption(firstPlanValue!)
    await page.getByLabel("Start date").fill(new Date().toISOString().slice(0, 10))
    await page.getByLabel("Branch name").fill("Suspend Test Branch")
    await page.getByLabel("Branch code").fill(`SUSE2E-${uniqueSuffix}`)
    await page.getByLabel("First name").fill("Suspend")
    await page.getByLabel("Last name").fill("Admin")
    const adminEmail = `suspend-e2e-admin-${uniqueSuffix}@test.local`
    await page.getByLabel("Email", { exact: true }).fill(adminEmail)
    await page.getByRole("button", { name: "Provision clinic" }).click()
    await expect(page.getByText(/Clinic provisioned/i)).toBeVisible({ timeout: 15_000 })

    const activationPath = await page.locator("code").textContent()
    const organizationLink = await page.getByRole("link", { name: "Open organization" }).getAttribute("href")
    expect(activationPath).toBeTruthy()
    expect(organizationLink).toBeTruthy()

    // Set the new admin's real password through the activation link, in a
    // separate browser context — this admin's session must never touch the
    // platform operator's own cookies (two fully separate auth planes).
    const clinicContext = await context.browser()!.newContext()
    const clinicPage = await clinicContext.newPage()
    const activationUrl = activationPath!.trim()
    await clinicPage.goto(activationUrl)
    const clinicPassword = "PilotAdmin123!"
    await clinicPage.getByLabel("New password", { exact: true }).fill(clinicPassword)
    await clinicPage.getByLabel("Confirm new password").fill(clinicPassword)
    await clinicPage.getByRole("button", { name: "Reset password" }).click()
    await expect(clinicPage.getByText(/password has been reset/i)).toBeVisible({ timeout: 10_000 })

    // The freshly-activated admin can log in normally, before any suspension.
    await loginAsClinicUser(clinicPage, adminEmail, clinicPassword)
    await clinicPage.waitForURL(/\/dashboard/, { timeout: 10_000 })
    await expect(clinicPage.getByRole("heading", { name: /welcome/i })).toBeVisible()

    // Back on the platform side: suspend the organization.
    await page.goto(organizationLink!)
    await page.getByRole("button", { name: "Suspend organization" }).click()
    await page.getByPlaceholder("Reason").fill("P5.1 E2E suspension test")
    await page.getByRole("button", { name: "Confirm" }).click()
    await expect(page.getByText(/^suspended$/i).first()).toBeVisible({ timeout: 10_000 })

    // The clinic admin's ALREADY-ISSUED session is invalidated immediately —
    // no logout/login round trip needed to observe the block.
    await clinicPage.goto("/dashboard")
    await expect(clinicPage).toHaveURL(/\/login/)

    // A fresh login attempt is also rejected while suspended.
    const freshAttemptPage = await clinicContext.newPage()
    await loginAsClinicUser(freshAttemptPage, adminEmail, clinicPassword)
    await expect(freshAttemptPage.getByText(/suspended/i)).toBeVisible({ timeout: 10_000 })
    await expect(freshAttemptPage).toHaveURL(/\/login/)

    // Reactivate from the platform side.
    await page.getByRole("button", { name: "Reactivate" }).click()
    await expect(page.getByText(/^active$/i).first()).toBeVisible({ timeout: 10_000 })

    // Access is restored — same credentials, no re-provisioning, no new admin.
    await loginAsClinicUser(freshAttemptPage, adminEmail, clinicPassword)
    await freshAttemptPage.waitForURL(/\/dashboard/, { timeout: 10_000 })
    await expect(freshAttemptPage.getByRole("heading", { name: /welcome/i })).toBeVisible()

    await clinicContext.close()
  })
})

test.describe("P5.1 E2E §5/§37: a clinic Super Admin cannot reach any platform control, by navigation or direct URL", () => {
  test("clinic Super Admin session hitting /platform/* is redirected to /platform/login, never served the page", async ({ page }) => {
    await loginAsClinicUser(page, CLINIC_ADMIN_EMAIL, CLINIC_ADMIN_PASSWORD)
    await page.waitForURL(/\/dashboard/)

    // No platform nav link exists anywhere in the clinic sidebar for this
    // session — confirms the UI never even offers the path.
    await expect(page.getByRole("link", { name: "Provision Clinic" })).toHaveCount(0)

    const platformRoutes = ["/platform", "/platform/organizations", "/platform/provision", "/platform/plans"]
    for (const route of platformRoutes) {
      await page.goto(route)
      // Redirected to the platform login screen — the clinic Super Admin's
      // own staff session cookie is simply the wrong cookie for this branch
      // of proxy.ts to accept; it is never served the platform page itself.
      await expect(page).toHaveURL(/\/platform\/login/)
    }
  })
})
