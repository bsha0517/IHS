import { expect, type Page } from "@playwright/test"
import { Client } from "pg"

/** Same pattern as test/e2e/p5-3/fixtures.ts's own withDb — direct DB verification, never UI-only. Self-contained here rather than imported cross-phase, so P5.4's own test files never depend on P5.3's fixture file changing. */
export async function withDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: "postgresql://postgres:postgres@localhost:5433/his_dev?schema=public" })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

export const OPERATOR_EMAIL = "operator@avant.local"
export const OPERATOR_PASSWORD = "ChangeMe123!"
export const DEFAULT_PASSWORD = "Pilot2026!Uat"

export async function loginAsPlatformOperator(page: Page) {
  await page.goto("/platform/login")
  await page.getByLabel("Email").fill(OPERATOR_EMAIL)
  await page.getByLabel("Password").fill(OPERATOR_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await page.waitForURL(/\/platform$/)
}

export async function loginAsClinicUser(page: Page, email: string, password: string) {
  await page.goto("/login")
  await page.getByLabel("Email", { exact: true }).fill(email)
  await page.getByLabel("Password").fill(password)
  await page.getByRole("button", { name: "Sign in" }).click()
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 45_000 })
}

export async function activatePassword(page: Page, activationPath: string, password: string) {
  await page.goto(activationPath)
  await page.getByLabel("New password", { exact: true }).fill(password)
  await page.getByLabel("Confirm new password").fill(password)
  await page.getByRole("button", { name: "Reset password" }).click()
  await expect(page.getByText(/password has been reset/i)).toBeVisible({ timeout: 10_000 })
}
