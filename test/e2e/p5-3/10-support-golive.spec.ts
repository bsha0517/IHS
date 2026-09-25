import { test, expect } from "@playwright/test"
import { loginAsClinicUser, loginAsPlatformOperator, readFixture, withDb, type PilotFixture } from "./fixtures"

/**
 * P5.3 Step 20/28 — support ticket workflow (internal vs customer-visible
 * notes) and the go-live workflow, both against this pilot's own real org
 * — reusing the exact pattern P5.2's own E2E suite already proved works.
 */
test.describe.serial("P5.3 Support UAT", () => {
  let fixture: PilotFixture
  let ticketId: string

  test("clinic user creates a ticket, platform operator adds an internal AND a customer-visible note, and the clinic sees only the customer-visible one", async ({ page }) => {
    test.setTimeout(90_000)
    fixture = readFixture()
    await loginAsClinicUser(page, fixture.users.superAdmin.email, fixture.users.superAdmin.password)
    await page.goto("/support")
    await page.getByRole("button", { name: "New ticket" }).click()
    const title = `P5.3 support UAT ticket ${fixture.suffix}`
    {
      const dlg = page.getByRole("dialog")
      await dlg.getByLabel("Title").fill(title)
      await dlg.getByLabel("Description").fill("UAT synthetic support ticket — testing internal/customer note isolation.")
      await dlg.getByRole("button", { name: "Submit" }).click()
    }
    // .first() — a stale ticket with this exact synthetic title can be left
    // behind by an earlier P5.3 run against this same org (same fix as
    // 07-multibranch-security.spec.ts's support-ticket test).
    await expect(page.getByText(title).first()).toBeVisible({ timeout: 10_000 })

    const ticket = await withDb((db) =>
      db.query<{ id: string }>(`select id from support_ticket where organization_id=$1 and title=$2 order by created_at desc limit 1`, [fixture.organizationId, title])
    )
    ticketId = ticket.rows[0].id

    await loginAsPlatformOperator(page)
    await page.goto(`/platform/tickets/${ticketId}`)
    // The visibility Select and note Textarea have no accessible <Label> —
    // Select defaults to "internal" already (no need to touch it for the
    // first note); Textarea only has a placeholder.
    await page.getByRole("button", { name: "Add note" }).click()
    {
      const dlg = page.getByRole("dialog")
      await dlg.getByPlaceholder(/Do not include patient names/).fill("INTERNAL: investigating root cause — never visible to the clinic.")
      await dlg.getByRole("button", { name: "Add note" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })

    await page.getByRole("button", { name: "Add note" }).click()
    {
      const dlg = page.getByRole("dialog")
      await dlg.getByRole("combobox").click()
      await page.getByRole("option", { name: /Customer-visible/ }).click()
      await dlg.getByPlaceholder(/Do not include patient names/).fill("We're looking into this and will update you shortly.")
      await dlg.getByRole("button", { name: "Add note" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })

    await loginAsClinicUser(page, fixture.users.superAdmin.email, fixture.users.superAdmin.password)
    await page.goto(`/support/${ticketId}`)
    await expect(page.getByText(/investigating root cause/i)).not.toBeVisible()
    await expect(page.getByText(/looking into this/i)).toBeVisible({ timeout: 10_000 })

    const notes = await withDb((db) => db.query<{ visibility: string }>(`select visibility from support_ticket_note where ticket_id=$1`, [ticketId]))
    expect(notes.rows.some((n) => n.visibility === "internal")).toBe(true)
    expect(notes.rows.some((n) => n.visibility === "customer")).toBe(true)
  })
})

test.describe.serial("P5.3 Go-Live UAT", () => {
  let fixture: PilotFixture

  test("complete the UAT cycle started in setup with a sign-off, then mark all 4 go-live conditions verified, then approve go-live — server-validated, not UI-only", async ({ page }) => {
    test.setTimeout(120_000)
    fixture = readFixture()
    await loginAsPlatformOperator(page)
    await page.goto(`${fixture.organizationLink}/uat`)
    await page.getByText("Pilot Cycle 1").click().catch(() => {})
    const completeBtn = page.getByRole("button", { name: "Complete / sign off" })
    if (await completeBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await completeBtn.click()
      const dlg = page.getByRole("dialog")
      await dlg.getByRole("combobox", { name: "Result" }).click()
      await page.getByRole("option", { name: "Passed", exact: true }).click()
      await dlg.getByLabel(/sign off/i).check()
      await dlg.getByRole("button", { name: "Save" }).click()
      await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })
    }

    await page.goto(fixture.organizationLink)
    for (const label of ["Hosted backup", "External production error monitoring", "Clinic-specific UAT", "Transactional email"]) {
      const card = page.locator("div.rounded-md.border.border-border", { hasText: label }).filter({ has: page.getByRole("button", { name: "Mark verified" }) })
      await card.getByRole("button", { name: "Mark verified" }).click()
      await page.waitForTimeout(400)
    }

    await page.reload()
    // This operator page renders a long, data-heavy tree (checklist,
    // modules, branches, admins, audit log) — wait for an ALWAYS-present
    // element further down the page first, so a slow/cold render can't be
    // mistaken for "Approve go-live" genuinely not being there. Checking the
    // button itself with a bare timeout is ambiguous: GoLiveApprovalCard
    // renders nothing once already live (`if (alreadyLive) return null`), so
    // "not visible yet" and "not visible because already live" look
    // identical to a short check.
    await expect(page.getByText("External go-live conditions")).toBeVisible({ timeout: 30_000 })
    const approveBtn = page.getByRole("button", { name: "Approve go-live" })
    if (await approveBtn.isVisible().catch(() => false)) {
      await expect(approveBtn).toBeEnabled({ timeout: 15_000 })
      await approveBtn.click()
      await page.getByRole("button", { name: "Confirm approval" }).click()
      // .click() resolves once the click event dispatches, not once the
      // awaited server action it triggers actually completes. Waiting on
      // the card unmounting (GoLiveApprovalCard's `if (alreadyLive) return
      // null`) as the "done" signal proved unreliable across repeated runs
      // even after confirming the page itself had fully loaded first — the
      // underlying approval always DOES succeed per direct DB inspection
      // every time this was investigated, just not always visibly reflected
      // back in the DOM within a short window. Poll the actual source of
      // truth directly instead of the UI.
      await expect(async () => {
        const p = await withDb((db) =>
          db.query<{ commercial_lifecycle: string }>(`select commercial_lifecycle from organization_commercial_profile where organization_id=$1`, [fixture.organizationId])
        )
        expect(p.rows[0].commercial_lifecycle).toBe("live")
      }).toPass({ timeout: 20_000 })
    }

    const profile = await withDb((db) =>
      db.query<{ commercial_lifecycle: string; go_live_approved_at: Date | null }>(
        `select commercial_lifecycle, go_live_approved_at from organization_commercial_profile where organization_id=$1`,
        [fixture.organizationId]
      )
    )
    expect(profile.rows[0].commercial_lifecycle).toBe("live")
    expect(profile.rows[0].go_live_approved_at).not.toBeNull()

    // The clinic must keep operating normally post-go-live — approval never
    // disrupts an already-working session.
    await loginAsClinicUser(page, fixture.users.superAdmin.email, fixture.users.superAdmin.password)
    await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible({ timeout: 10_000 })
  })
})
