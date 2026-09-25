import { expect, type Page } from "@playwright/test"
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import path from "node:path"
import { Client } from "pg"

/**
 * Direct DB access for verification (P5.3's own explicit requirement: "Do
 * not simply test the UI... verify resulting database/application state")
 * and for looking up real ids the UI doesn't expose as a stable selector —
 * e.g. a table row's own primary key. Same connection string pattern as
 * the project's own scripts/db/*.ts, restricted-nothing superuser only for
 * local-dev verification, never used for any mutation.
 */
export async function withDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: "postgresql://postgres:postgres@localhost:5433/his_dev?schema=public" })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/**
 * P5.3 — cross-file state for the pilot-clinic UAT suite. Each stage file
 * reads the fixture written by the previous one (00-setup.spec.ts writes
 * it first) rather than re-provisioning — a real clinic's reception/doctor/
 * lab/pharmacy/billing workflows all operate on the SAME organization,
 * branches, users, providers and master data, exactly like this suite does.
 * Not committed (see .gitignore) — regenerated fresh every run.
 */
const FIXTURE_PATH = path.join(__dirname, ".pilot-fixture.json")

export type UserCred = { email: string; password: string; userId?: string }

export type PilotFixture = {
  suffix: string
  organizationId: string
  organizationLink: string
  branchA: { id: string; name: string; code: string }
  branchB: { id: string; name: string; code: string }
  users: {
    superAdmin: UserCred
    receptionist: UserCred
    doctor1: UserCred
    doctor2: UserCred
    nurse: UserCred
    pharmacist: UserCred
    labTech: UserCred
    radTech: UserCred
    inventoryMgr: UserCred
    accountant: UserCred
    hrManager: UserCred
  }
  providers: { doctor1Id: string; doctor2Id: string; nurseId: string }
  services: { consultationId: string; consultationName: string; procedureId: string; procedureName: string }
  products: { consumableSku: string; consumableName: string; retailSku: string; retailName: string }
  medications: { medASku: string; medAName: string; medBSku: string; medBName: string }
  suppliers: { supplierAId: string; supplierACode: string }
  labTests: { cbcId: string; cbcName: string }
  imagingServices: { xrayId: string; xrayName: string }
  payors: { selfPayId: string; insuranceId: string; insuranceName: string }
  accounts: Record<string, string>
  packages: { basicPackageId?: string; basicPackageName?: string }
  patients: Record<string, string>
}

export function readFixture(): PilotFixture {
  if (!existsSync(FIXTURE_PATH)) {
    throw new Error(
      `P5.3 fixture not found at ${FIXTURE_PATH} — run 00-setup.spec.ts first (it must complete successfully before any other p5-3 stage can run).`
    )
  }
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"))
}

export function writeFixture(fixture: PilotFixture): void {
  writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2))
}

export function patchFixture(patch: Partial<PilotFixture>): PilotFixture {
  const current = readFixture()
  const next = { ...current, ...patch }
  writeFixture(next)
  return next
}

export const OPERATOR_EMAIL = "operator@avant.local"
export const OPERATOR_PASSWORD = "ChangeMe123!"
export const DEFAULT_PILOT_PASSWORD = "Pilot2026!Uat"

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
  // NOT always /dashboard — resolveDefaultLandingRoute() (src/lib/platform/
  // landing.ts) sends most operational roles somewhere more useful on
  // login (Receptionist → /reception, Pharmacist → /pharmacy, Lab Tech →
  // /laboratory, etc.) — a real, deliberate P3.12 feature this suite's own
  // helper wrongly assumed away. Wait for navigation off /login instead of
  // a specific destination. 45s, not 20s — the first render of any route
  // for a brand-new org on a cold Turbopack dev-server cache has
  // repeatedly taken longer than 20s in this environment (documented in
  // P5.2's own completion report); every p5-3 stage's own test.setTimeout
  // is sized with this in mind.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 45_000 })
}

/** Activates a just-provisioned/just-created user's one-time reset link to a known password. */
export async function activatePassword(page: Page, activationPath: string, password: string) {
  await page.goto(activationPath)
  await page.getByLabel("New password", { exact: true }).fill(password)
  await page.getByLabel("Confirm new password").fill(password)
  await page.getByRole("button", { name: "Reset password" }).click()
  await expect(page.getByText(/password has been reset/i)).toBeVisible({ timeout: 10_000 })
}
