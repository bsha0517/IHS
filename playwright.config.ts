import { defineConfig, devices } from "@playwright/test"

/**
 * P4.7A §67/§68/§95 — a small, focused browser smoke suite, not hundreds of
 * E2E tests: "does the critical UI actually render and respond?" Runs
 * against the real `next dev` server (started automatically if not already
 * running) on local Postgres — the same `his_dev` database every other
 * manual browser-verification pass in this engagement has used, never
 * production/Supabase. See docs/FRONTEND_TESTING.md for how to run this and
 * what it deliberately does not cover.
 */
export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false, // one shared login/session flow per file; keep runs deterministic and light
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"]],
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
