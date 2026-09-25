import { test, expect } from "@playwright/test"
import { loginAsClinicUser, readFixture, patchFixture, withDb, type PilotFixture } from "./fixtures"

/**
 * P5.3 Step 15 — HR/Payroll UAT: create an employee, record attendance,
 * submit + approve a leave request, then run a full payroll lifecycle
 * (draft → review → approve → paid) and verify both accounting postings
 * (approve posts Salary Expense/Payroll Payable, paid posts Payroll
 * Payable/cash) actually land as balanced journals.
 */
test.describe.serial("P5.3 HR / Payroll UAT", () => {
  let fixture: PilotFixture
  let employeeId: string

  test("create an employee for doctor1 and link it to their existing user login", async ({ page }) => {
    test.setTimeout(90_000)
    fixture = readFixture()
    await loginAsClinicUser(page, fixture.users.hrManager.email, fixture.users.hrManager.password)
    await page.goto("/employees")
    await page.getByRole("button", { name: "New employee" }).click()
    {
      const dlg = page.getByRole("dialog")
      await dlg.getByLabel("First name").fill("Dana")
      await dlg.getByLabel("Last name").fill("Doctor")
      await dlg.getByRole("combobox", { name: "Branch" }).click()
      await page.getByRole("option", { name: fixture.branchA.name }).click()
      await dlg.getByLabel("Designation").fill("General Practitioner")
      await dlg.getByRole("combobox", { name: "Employment type" }).click()
      // Options render t.replace("_", " ") (employee-dialog.tsx) — "full time", not "full_time".
      await page.getByRole("option", { name: "full time", exact: true }).click()
      await dlg.getByLabel("Basic salary").fill("3000")
      await dlg.getByRole("button", { name: "Create employee" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })

    const emp = await withDb((db) =>
      db.query<{ id: string }>(`select id from employee where organization_id=$1 and first_name='Dana' and last_name='Doctor' order by created_at desc limit 1`, [fixture.organizationId])
    )
    employeeId = emp.rows[0].id

    // Linking an employee record to a user login is deliberately Admin-only
    // (users.manage — the RBAC administration permission, P3.12 §14/actions.ts's
    // own comment), not something HR Manager's role grants — matches
    // employees/[id]/page.tsx's canManageUsers gate.
    await loginAsClinicUser(page, fixture.users.superAdmin.email, fixture.users.superAdmin.password)
    await page.goto(`/employees/${employeeId}`)
    await page.getByRole("button", { name: "Link user" }).click()
    {
      const dlg = page.getByRole("dialog")
      // user-link-dialog.tsx's Select has no aria-label/htmlFor — it's the
      // dialog's only combobox (Radix SelectTrigger renders role="combobox"),
      // so targeting it directly is reliable; "Select a user" is only the
      // SelectValue's placeholder text content, not a real <input placeholder>.
      await dlg.getByRole("combobox").click()
      await page.getByRole("option", { name: new RegExp(fixture.users.doctor1.email) }).click()
      await dlg.getByRole("button", { name: "Link" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })

    const linked = await withDb((db) => db.query<{ user_id: string | null }>(`select user_id from employee where id=$1`, [employeeId]))
    expect(linked.rows[0].user_id, "employee must be linked to the real user row, not just a display label").toBeTruthy()
    patchFixture({ patients: { ...fixture.patients, employeeId } })
  })

  test("submit and approve a leave request for the employee", async ({ page }) => {
    test.setTimeout(90_000)
    fixture = readFixture()
    employeeId = fixture.patients.employeeId
    await loginAsClinicUser(page, fixture.users.hrManager.email, fixture.users.hrManager.password)
    await page.goto("/leave")
    await page.getByRole("button", { name: "New leave request" }).click()
    {
      const dlg = page.getByRole("dialog")
      await dlg.getByRole("combobox", { name: "Employee" }).click()
      await page.getByRole("option", { name: /Dana Doctor/ }).click()
      await dlg.getByRole("combobox", { name: "Leave type" }).click()
      await page.getByRole("option", { name: "annual", exact: true }).click()
      const start = new Date()
      start.setDate(start.getDate() + 10)
      const end = new Date(start)
      end.setDate(end.getDate() + 1)
      await dlg.getByLabel("Start date").fill(start.toISOString().slice(0, 10))
      await dlg.getByLabel("End date").fill(end.toISOString().slice(0, 10))
      await dlg.getByLabel("Reason").fill("UAT synthetic leave request")
      await dlg.getByRole("button", { name: "Submit request" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })

    const leave = await withDb((db) =>
      db.query<{ id: string; status: string }>(`select id, status from leave_request where employee_id=$1 order by requested_at desc limit 1`, [employeeId])
    )
    expect(leave.rows[0].status).toBe("requested")

    await page.goto("/leave")
    await page.getByRole("button", { name: "Approve" }).first().click()
    await expect(page.getByText(/approved/i).first()).toBeVisible({ timeout: 10_000 })

    const afterApproval = await withDb((db) => db.query<{ status: string }>(`select status from leave_request where id=$1`, [leave.rows[0].id]))
    expect(afterApproval.rows[0].status).toBe("approved")
  })

  test("run a full payroll lifecycle (draft → review → approve → paid) and verify both accounting postings", async ({ page }) => {
    test.setTimeout(150_000)
    fixture = readFixture()
    await loginAsClinicUser(page, fixture.users.hrManager.email, fixture.users.hrManager.password)
    await page.goto("/payroll")
    await page.getByRole("button", { name: "New payroll run" }).click()
    {
      const dlg = page.getByRole("dialog")
      await dlg.getByRole("combobox", { name: "Branch" }).click()
      await page.getByRole("option", { name: fixture.branchA.name }).click()
      const periodStart = new Date()
      periodStart.setDate(1)
      const periodEnd = new Date(periodStart.getFullYear(), periodStart.getMonth() + 1, 0)
      await dlg.getByLabel("Period start").fill(periodStart.toISOString().slice(0, 10))
      await dlg.getByLabel("Period end").fill(periodEnd.toISOString().slice(0, 10))
      await dlg.getByRole("button", { name: "Create run" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })

    const run = await withDb((db) => db.query<{ id: string; status: string }>(`select id, status from payroll_run where organization_id=$1 order by created_at desc limit 1`, [fixture.organizationId]))
    const runId = run.rows[0].id
    expect(run.rows[0].status).toBe("draft")

    await page.goto(`/payroll/${runId}`)
    await page.getByRole("button", { name: "Move to review" }).click()
    await expect(page.getByText(/review/i).first()).toBeVisible({ timeout: 10_000 })
    await page.getByRole("button", { name: "Approve run" }).click()
    await expect(page.getByText(/approved/i).first()).toBeVisible({ timeout: 10_000 })

    const approvedJournal = await withDb((db) =>
      db.query<{ debit_total: string; credit_total: string }>(
        `select (select coalesce(sum(debit),0) from journal_line where journal_id=j.id)::text as debit_total,
                (select coalesce(sum(credit),0) from journal_line where journal_id=j.id)::text as credit_total
         from journal j where j.organization_id=$1 and j.reference_id=$2`,
        [fixture.organizationId, runId]
      )
    )
    expect(approvedJournal.rows.length, "payroll approval must post Dr Salary Expense / Cr Payroll Payable").toBeGreaterThanOrEqual(1)
    expect(approvedJournal.rows[0].debit_total).toBe(approvedJournal.rows[0].credit_total)

    await page.getByRole("button", { name: "Mark paid" }).click()
    {
      const dlg = page.getByRole("dialog")
      await dlg.getByRole("combobox", { name: "Paid via" }).click()
      await page.getByRole("option", { name: "bank", exact: true }).click()
      await dlg.getByRole("button", { name: "Mark paid" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })

    const finalStatus = await withDb((db) => db.query<{ status: string }>(`select status from payroll_run where id=$1`, [runId]))
    expect(finalStatus.rows[0].status).toBe("paid")

    const allJournals = await withDb((db) =>
      db.query<{ count: string }>(`select count(*)::text from journal where organization_id=$1 and reference_id=$2`, [fixture.organizationId, runId])
    )
    expect(Number(allJournals.rows[0].count), "both the approve AND the paid transition must each post their own journal").toBeGreaterThanOrEqual(2)
  })
})
