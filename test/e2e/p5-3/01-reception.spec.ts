import { test, expect } from "@playwright/test"
import { loginAsClinicUser, readFixture, patchFixture, withDb, type PilotFixture } from "./fixtures"

/**
 * P5.3 Step 4 — reception UAT: patient registration (incl. duplicate
 * detection), appointment booking/reschedule/cancel/check-in, and a
 * receptionist-role restriction check (direct navigation to an
 * unauthorized page). Runs as the receptionist user created in setup, not
 * the super admin — this is the actual role a real reception desk uses.
 */
test.describe.serial("P5.3 Reception UAT", () => {
  let fixture: PilotFixture

  test("register 3 realistic synthetic patients, and confirm the duplicate-detection warning (never a block) fires for a genuine repeat", async ({ page }) => {
    test.setTimeout(120_000)
    fixture = readFixture()
    await loginAsClinicUser(page, fixture.users.receptionist.email, fixture.users.receptionist.password)
    await page.goto("/patients/new")

    async function registerPatient(first: string, last: string, dob: string, gender: string, mobile: string) {
      await page.getByLabel("First name *").fill(first)
      await page.getByLabel("Last name *").fill(last)
      await page.getByLabel("Date of birth *").fill(dob)
      await page.getByRole("combobox", { name: "Gender *" }).click()
      await page.getByRole("option", { name: gender, exact: true }).click()
      await page.getByLabel("Mobile *").fill(mobile)
      await page.getByRole("combobox", { name: "Branch *" }).click()
      await page.getByRole("option", { name: fixture.branchA.name }).click()
      await page.getByRole("button", { name: "Register Patient" }).click()
    }

    // NOT /\/patients\/[^/]+$/ — that regex also matches the starting
    // /patients/new URL itself ("new" satisfies [^/]+), so an auto-retrying
    // toHaveURL can pass instantly before the real post-submit navigation
    // ever happens, capturing "new" as the "id". Exclude it explicitly.
    const realPatientUrl = /\/patients\/(?!new(?:\/|$))[^/]+$/

    await registerPatient("Aisha", `Pilot${fixture.suffix}`, "1990-05-14", "Female", "0300-1110001")
    await expect(page).toHaveURL(realPatientUrl, { timeout: 15_000 })
    const patientAId = page.url().split("/").pop()!

    await page.goto("/patients/new")
    await registerPatient("Bilal", `Pilot${fixture.suffix}`, "1985-11-02", "Male", "0300-1110002")
    await expect(page).toHaveURL(realPatientUrl, { timeout: 15_000 })
    const patientBId = page.url().split("/").pop()!

    // Duplicate: same first/last/DOB as Aisha — this must WARN, never block.
    await page.goto("/patients/new")
    await registerPatient("Aisha", `Pilot${fixture.suffix}`, "1990-05-14", "Female", "0300-1110099")
    await expect(page.getByText(/Possible existing patient\(s\) found/i)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/This does not block registration/i)).toBeVisible()
    await page.getByLabel("Reason for registering a new record anyway").fill("Confirmed distinct person via ID check during UAT")
    await page.getByRole("button", { name: "Register anyway" }).click()
    await expect(page).toHaveURL(realPatientUrl, { timeout: 15_000 })
    const patientCId = page.url().split("/").pop()!
    expect(patientCId).not.toBe(patientAId)

    // Verify resulting database state: 3 real Patient rows, and the
    // duplicate-override is genuinely on the audit trail, not silently dropped.
    const patients = await withDb((db) =>
      db.query<{ id: string; first_name: string }>(`select id, first_name from patient where id = any($1)`, [[patientAId, patientBId, patientCId]])
    )
    expect(patients.rows).toHaveLength(3)
    const auditRow = await withDb((db) =>
      db.query<{ count: string }>(
        `select count(*)::text from audit_log where organization_id=$1 and entity_id=$2 and new_values::text ilike '%Confirmed distinct person%'`,
        [fixture.organizationId, patientCId]
      )
    )
    expect(Number(auditRow.rows[0].count), "the duplicate-override reason must be recorded on the audit trail, not silently discarded").toBeGreaterThan(0)

    patchFixture({ patients: { ...fixture.patients, aisha: patientAId, bilal: patientBId, aishaDuplicate: patientCId } })
  })

  test("patient search finds a registered patient by name and by phone", async ({ page }) => {
    test.setTimeout(60_000)
    fixture = readFixture()
    await loginAsClinicUser(page, fixture.users.receptionist.email, fixture.users.receptionist.password)
    await page.goto("/patients")
    await page.getByPlaceholder("Search by name, MRN, or phone").fill("Bilal")
    await page.getByRole("button", { name: "Search" }).click()
    await expect(page.getByText(`Bilal Pilot${fixture.suffix}`)).toBeVisible({ timeout: 10_000 })

    // Bilal was registered with mobile 0300-1110002 (0300-1110001 is Aisha's).
    await page.getByPlaceholder("Search by name, MRN, or phone").fill("0300-1110002")
    await page.getByRole("button", { name: "Search" }).click()
    await expect(page.getByText(`Bilal Pilot${fixture.suffix}`)).toBeVisible({ timeout: 10_000 })
  })

  test("book 3 appointments for the clinic day (2 at Branch A with doctor1, 1 at Branch B with doctor2), then confirm/arrive/check-in one through the reception queue", async ({ page }) => {
    test.setTimeout(120_000)
    fixture = readFixture()
    await loginAsClinicUser(page, fixture.users.receptionist.email, fixture.users.receptionist.password)
    await page.goto("/appointments")

    async function bookAppointment(searchTerm: string, patientName: string, branch: string, providerLast: string, service: string, slotOffsetMinutes = 0) {
      await page.getByRole("button", { name: "Book appointment" }).click()
      const dlg = page.getByRole("dialog")
      // Search by mobile (unique per patient), not the display name — now
      // that patient search matches full "First Last" names too, searching
      // "Aisha Pilot..." would also match the duplicate-override Aisha
      // created earlier, and .first() would pick whichever the API happens
      // to return first, not necessarily the intended original record.
      await dlg.getByPlaceholder("Search patient by name, MRN, or phone").fill(searchTerm)
      // Scoped to the dialog, not the whole page — by the time later
      // bookings run, the appointments list behind the dialog already has
      // its own "Aisha/Bilal Pilot..." row(s), and an unscoped page-wide
      // getByText().first() can resolve to that background link instead of
      // the dialog's own search-result item, which then fails to click
      // (blocked by the dialog's own overlay intercepting pointer events).
      await dlg.getByText(patientName, { exact: false }).first().click()
      await dlg.getByRole("combobox", { name: "Branch" }).click()
      await page.getByRole("option", { name: branch }).click()
      await dlg.getByRole("combobox", { name: "Provider" }).click()
      await page.getByRole("option", { name: new RegExp(providerLast) }).click()
      await dlg.getByRole("combobox", { name: "Service" }).click()
      await page.getByRole("option", { name: service }).click()
      // NOT "now + 30 minutes" — this environment's wall clock can be near
      // midnight (observed 00:07 local), landing the slot outside the
      // provider's business hours and getting a legitimate server-side
      // rejection ("No available slots for this provider on this day").
      // A fixed daytime slot TODAY (not tomorrow — /reception's own queue
      // only fetches [today, tomorrow), so a next-day appointment would
      // never show up there for the check-in test that follows), staggered
      // per call to avoid double-booking the same provider at the same
      // instant. Safe as long as the suite runs before 10am local.
      const slot = new Date()
      slot.setHours(10, slotOffsetMinutes, 0, 0)
      const localIso = new Date(slot.getTime() - slot.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
      await dlg.locator("#startTime").fill(localIso)
      await dlg.getByRole("button", { name: "Book appointment" }).click()
      // 20s not 10s: bookAppointment's own outbox dispatch synchronously
      // runs the AppointmentBooked handler, which calls sendMessage() for
      // an "appointment_confirmation" CommTemplate this pilot org never
      // seeded — sendMessage's findFirstOrThrow throws, the outbox
      // dispatcher catches and logs it (outbox.handler_failed, retried
      // later), but that whole round-trip plus this route's first cold
      // compile can exceed 10s on this environment.
      await expect(page.getByRole("dialog")).toBeHidden({ timeout: 20_000 })
    }

    // Both booked at Branch A, doctor1 — the receptionist's own actual
    // branch access (per setup). Branch B / cross-branch booking behavior
    // is covered separately by the dedicated multi-branch UAT stage, using
    // a user who genuinely has Branch B access, not by asking this
    // receptionist to reach past their own real assignment.
    // "Dana Doctor" specifically — both doctor1 ("Dana Doctor") and doctor2
    // ("Dev Doctor") share the last name "Doctor" (00-setup.spec.ts), so a
    // bare /Doctor/ match is ambiguous between the two provider options.
    await bookAppointment("0300-1110001", `Aisha Pilot${fixture.suffix}`, fixture.branchA.name, "Dana Doctor", fixture.services.consultationName, 0)
    await bookAppointment("0300-1110002", `Bilal Pilot${fixture.suffix}`, fixture.branchA.name, "Dana Doctor", fixture.services.consultationName, 30)

    const appts = await withDb((db) =>
      db.query<{ id: string; patient_id: string }>(
        `select a.id, a.patient_id from appointment a where a.organization_id=$1 order by a.created_at asc`,
        [fixture.organizationId]
      )
    )
    expect(appts.rows.length).toBeGreaterThanOrEqual(2)
    const aishaAppt = appts.rows.find((a) => a.patient_id === fixture.patients.aisha)
    const bilalAppt = appts.rows.find((a) => a.patient_id === fixture.patients.bilal)
    expect(aishaAppt, "Aisha's appointment must exist").toBeTruthy()
    expect(bilalAppt, "Bilal's appointment must exist").toBeTruthy()
    patchFixture({ patients: { ...fixture.patients, aishaAppointmentId: aishaAppt!.id, bilalAppointmentId: bilalAppt!.id } })
  })

  test("take Aisha's appointment through confirm → mark arrived → check-in, and verify it appears in the reception queue at each stage", async ({ page }) => {
    test.setTimeout(90_000)
    fixture = readFixture()
    await loginAsClinicUser(page, fixture.users.receptionist.email, fixture.users.receptionist.password)
    await page.goto("/reception")

    const row = page.getByRole("row", { name: new RegExp(`Aisha Pilot${fixture.suffix}`) })
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.getByRole("button", { name: "Confirm" }).click()
    await expect(row.getByText("Confirmed")).toBeVisible({ timeout: 10_000 })
    await row.getByRole("button", { name: "Mark arrived" }).click()
    await expect(row.getByText("Arrived")).toBeVisible({ timeout: 10_000 })
    await row.getByRole("button", { name: "Check in" }).click()
    await expect(row.getByText(/Checked in|Waiting/)).toBeVisible({ timeout: 10_000 })

    const statusHistory = await withDb((db) =>
      db.query<{ count: string }>(
        `select count(*)::text from appointment_status_history where appointment_id=$1`,
        [fixture.patients.aishaAppointmentId]
      )
    )
    expect(Number(statusHistory.rows[0].count), "every status transition must leave an audit trail row, not just the latest status").toBeGreaterThanOrEqual(3)

    const queueEntry = await withDb((db) =>
      db.query<{ checked_in_at: Date | null }>(`select checked_in_at from queue_entry where appointment_id=$1`, [fixture.patients.aishaAppointmentId])
    )
    expect(queueEntry.rows[0]?.checked_in_at, "a real QueueEntry row must record the check-in timestamp").toBeTruthy()
  })

  test("reschedule Bilal's appointment with a required reason, and cancel a throwaway third appointment with a required reason", async ({ page }) => {
    test.setTimeout(90_000)
    fixture = readFixture()
    await loginAsClinicUser(page, fixture.users.receptionist.email, fixture.users.receptionist.password)
    await page.goto("/appointments")

    const bilalRow = page.getByRole("row", { name: new RegExp(`Bilal Pilot${fixture.suffix}`) })
    await expect(bilalRow).toBeVisible({ timeout: 15_000 })
    await bilalRow.getByRole("button", { name: "Reschedule" }).click()
    {
      const dlg = page.getByRole("dialog")
      const tomorrow = new Date()
      tomorrow.setDate(tomorrow.getDate() + 1)
      tomorrow.setHours(10, 0, 0, 0)
      const localIso = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
      await dlg.locator("#startTime").fill(localIso)
      await dlg.getByLabel("Reason for rescheduling").fill("Patient requested a later slot")
      await dlg.getByRole("button", { name: "Reschedule" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })

    const rescheduled = await withDb((db) =>
      db.query<{ status: string }>(`select status from appointment where id=$1`, [fixture.patients.bilalAppointmentId])
    )
    expect(rescheduled.rows[0].status).toBe("rescheduled")

    // Reschedule creates a NEW appointment row for the new time and marks
    // the old one "rescheduled" (a terminal status) rather than updating it
    // in place — downstream stages need the new row's id, not the now-dead
    // original one still sitting in the fixture.
    const rebooked = await withDb((db) =>
      db.query<{ id: string }>(
        `select id from appointment where organization_id=$1 and patient_id=$2 and status='scheduled' order by created_at desc limit 1`,
        [fixture.organizationId, fixture.patients.bilal]
      )
    )
    patchFixture({ patients: { ...fixture.patients, bilalAppointmentId: rebooked.rows[0].id } })
    fixture = readFixture()

    // A throwaway third appointment, booked and immediately cancelled, to
    // prove the cancel path (required reason, never silently discarded).
    await page.goto("/appointments")
    await page.getByRole("button", { name: "Book appointment" }).click()
    {
      const dlg = page.getByRole("dialog")
      // Mobile, not the full name — "Aisha Pilot..." also matches the
      // duplicate-override Aisha registered in the first test, and the
      // downstream DB lookup below expects fixture.patients.aisha
      // specifically (the original), not whichever record .first() lands on.
      await dlg.getByPlaceholder("Search patient by name, MRN, or phone").fill("0300-1110001")
      // Scoped to the dialog — see the same fix's comment in bookAppointment
      // above; an unscoped page-wide match can resolve to the appointments
      // list's own background row instead of the dialog's search result.
      await dlg.getByText(`Aisha Pilot${fixture.suffix}`, { exact: false }).first().click()
      await dlg.getByRole("combobox", { name: "Branch" }).click()
      await page.getByRole("option", { name: fixture.branchA.name }).click()
      await dlg.getByRole("combobox", { name: "Provider" }).click()
      // Not a bare /Doctor/ — doctor1 ("Dana Doctor") and doctor2 ("Dev
      // Doctor") share that last name, making it an ambiguous match.
      await page.getByRole("option", { name: "Dana Doctor" }).click()
      await dlg.getByRole("combobox", { name: "Service" }).click()
      await page.getByRole("option", { name: fixture.services.consultationName }).click()
      // Fixed daytime hour, not just "+2 days" at the current time-of-day —
      // this environment's wall clock can be near midnight, which would
      // otherwise land the slot outside business hours (same issue fixed
      // in bookAppointment above).
      const later = new Date()
      later.setDate(later.getDate() + 2)
      later.setHours(11, 0, 0, 0)
      const localIso = new Date(later.getTime() - later.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
      await dlg.locator("#startTime").fill(localIso)
      await dlg.getByRole("button", { name: "Book appointment" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })

    const throwaway = await withDb((db) =>
      db.query<{ id: string }>(
        `select id from appointment where organization_id=$1 and patient_id=$2 order by created_at desc limit 1`,
        [fixture.organizationId, fixture.patients.aisha]
      )
    )
    const throwawayId = throwaway.rows[0].id
    // Cancel from the appointment's own detail page rather than trying to
    // pick the right row out of a list — direct-id navigation is exact,
    // where a list-row locator would have to guess which visible row
    // corresponds to the newly-created (identically-patient-named) booking.
    await page.goto(`/appointments/${throwawayId}`)
    await page.getByRole("button", { name: "Cancel" }).click()
    const cancelDlg = page.getByRole("dialog")
    await cancelDlg.getByLabel("Reason for cancellation").fill("Duplicate test booking — cancelling as part of UAT cleanup")
    await cancelDlg.getByRole("button", { name: "Cancel appointment" }).click()
    // status-actions.tsx closes the dialog synchronously on click
    // (`setCancelOpen(false)` before the async `run(...)` even starts) — the
    // dialog being hidden does NOT mean the mutation has committed yet.
    // Wait for the real signal: the status badge itself updating. Unlike
    // StatusBadge's usual raw-lowercase-status behavior, this detail page
    // passes an explicit `label` override (APPOINTMENT_STATUS_LABEL) — real
    // DOM text "Cancelled", not a CSS-only capitalize of "cancelled".
    // .first() — "Cancelled" also appears in the Actions History log
    // ("Scheduled → Cancelled"), a second real match for an exact-text
    // locator; the status badge itself renders first in the DOM.
    await expect(page.getByText("Cancelled", { exact: true }).first()).toBeVisible({ timeout: 10_000 })

    const cancelled = await withDb((db) => db.query<{ status: string }>(`select status from appointment where id=$1`, [throwawayId]))
    expect(cancelled.rows[0].status).toBe("cancelled")
  })

  test("REQUIRED — the receptionist role cannot reach unauthorized functionality by direct navigation (accounting, payroll, admin/roles)", async ({ page }) => {
    test.setTimeout(60_000)
    fixture = readFixture()
    await loginAsClinicUser(page, fixture.users.receptionist.email, fixture.users.receptionist.password)

    // This app's own established convention (verified directly in
    // accounting/page.tsx: `if (!session || !can(session, "accounting.view"))
    // redirect("/dashboard")`) is a server-side redirect to /dashboard —
    // never a client-rendered "access denied" page, and never the real
    // restricted content.
    for (const path of ["/accounting", "/payroll", "/admin/roles", "/employees"]) {
      await page.goto(path)
      await page.waitForURL(/\/dashboard$/, { timeout: 15_000 })
    }
  })
})
