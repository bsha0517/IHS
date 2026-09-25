import { test, expect } from "@playwright/test"
import {
  loginAsPlatformOperator,
  loginAsClinicUser,
  activatePassword,
  writeFixture,
  patchFixture,
  withDb,
  DEFAULT_PILOT_PASSWORD,
  type PilotFixture,
} from "./fixtures"

/**
 * P5.3 Step 2/3 — provisions ONE realistic synthetic multi-branch pilot
 * clinic ("P5.3 Pilot Clinic") through the real onboarding workflow (never
 * a direct DB seed) and configures the master data every later UAT stage
 * needs. Reuses P5.2's proven provisioning E2E pattern. Every subsequent
 * p5-3 stage file reads the fixture this writes.
 */
test.describe.serial("P5.3 Setup — provision pilot clinic, branches, master data, users, providers", () => {
  const suffix = Date.now().toString().slice(-8)
  let fixture: PilotFixture

  test("provision the organization via /platform/provision with the Enterprise plan (full module coverage for UAT)", async ({ page }) => {
    test.setTimeout(120_000)
    await loginAsPlatformOperator(page)
    await page.goto("/platform/provision")

    await page.getByLabel("Display name").fill(`P5.3 Pilot Clinic ${suffix}`)
    await page.getByLabel("Legal name").fill(`P5.3 Pilot Clinic Legal ${suffix}`)
    await page.getByLabel("Country (ISO-2)").fill("PK")
    // Select the Enterprise plan by option text (not "first option" as P5.2's
    // helper does) — Enterprise is the only plan whose default module set
    // covers laboratory/radiology/pharmacy/hr/payroll/assets, all required
    // by this phase's UAT scope.
    const planSelect = page.locator('select[name="planId"]')
    const enterpriseValue = await planSelect.locator("option", { hasText: "Enterprise" }).getAttribute("value")
    await planSelect.selectOption(enterpriseValue!)
    await page.getByLabel("Start date").fill(new Date().toISOString().slice(0, 10))
    await page.getByLabel("Branch name").fill("Main Branch")
    await page.getByLabel("Branch code").fill(`P53-MAIN-${suffix}`.slice(0, 20))
    await page.getByLabel("First name").fill("Pilot")
    await page.getByLabel("Last name").fill("SuperAdmin")
    const adminEmail = `p53-superadmin-${suffix}@test.local`
    await page.getByLabel("Email", { exact: true }).fill(adminEmail)
    await page.getByRole("button", { name: "Provision clinic" }).click()
    await expect(page.getByText(/Clinic provisioned/i)).toBeVisible({ timeout: 15_000 })

    const activationPath = (await page.locator("code").textContent())!.trim()
    const orgLink = page.getByRole("link", { name: "Open organization" })
    await expect(orgLink).toHaveAttribute("href", /^\/platform\/organizations\/.+/, { timeout: 10_000 })
    const organizationLink = (await orgLink.getAttribute("href"))!
    const organizationId = organizationLink.split("/").pop()!

    fixture = {
      suffix,
      organizationId,
      organizationLink,
      branchA: { id: "", name: "Main Branch", code: `P53-MAIN-${suffix}`.slice(0, 20) },
      branchB: { id: "", name: "Secondary Branch", code: `P53-SEC-${suffix}`.slice(0, 20) },
      users: {
        superAdmin: { email: adminEmail, password: DEFAULT_PILOT_PASSWORD },
        receptionist: { email: `p53-reception-${suffix}@test.local`, password: DEFAULT_PILOT_PASSWORD },
        doctor1: { email: `p53-doctor1-${suffix}@test.local`, password: DEFAULT_PILOT_PASSWORD },
        doctor2: { email: `p53-doctor2-${suffix}@test.local`, password: DEFAULT_PILOT_PASSWORD },
        nurse: { email: `p53-nurse-${suffix}@test.local`, password: DEFAULT_PILOT_PASSWORD },
        pharmacist: { email: `p53-pharmacist-${suffix}@test.local`, password: DEFAULT_PILOT_PASSWORD },
        labTech: { email: `p53-labtech-${suffix}@test.local`, password: DEFAULT_PILOT_PASSWORD },
        radTech: { email: `p53-radtech-${suffix}@test.local`, password: DEFAULT_PILOT_PASSWORD },
        inventoryMgr: { email: `p53-inventory-${suffix}@test.local`, password: DEFAULT_PILOT_PASSWORD },
        accountant: { email: `p53-accountant-${suffix}@test.local`, password: DEFAULT_PILOT_PASSWORD },
        hrManager: { email: `p53-hr-${suffix}@test.local`, password: DEFAULT_PILOT_PASSWORD },
      },
      providers: { doctor1Id: "", doctor2Id: "", nurseId: "" },
      services: { consultationId: "", consultationName: `General Consultation ${suffix}`, procedureId: "", procedureName: `Wound Dressing ${suffix}` },
      products: { consumableSku: `CONS-${suffix}`, consumableName: `Gauze Roll ${suffix}`, retailSku: `RET-${suffix}`, retailName: `Vitamin C Tablets ${suffix}` },
      medications: { medASku: `MEDA-${suffix}`, medAName: `Amoxicillin 500mg ${suffix}`, medBSku: `MEDB-${suffix}`, medBName: `Paracetamol 500mg ${suffix}` },
      suppliers: { supplierAId: "", supplierACode: `SUP-${suffix}` },
      labTests: { cbcId: "", cbcName: `Complete Blood Count ${suffix}` },
      imagingServices: { xrayId: "", xrayName: `Chest X-Ray ${suffix}` },
      payors: { selfPayId: "", insuranceId: "", insuranceName: `Pilot Health Insurance ${suffix}` },
      accounts: {},
      packages: {},
      patients: {},
    }
    writeFixture(fixture)

    // Activate the super admin's real password so every later stage can log
    // in normally — mirrors the real onboarding runbook's own step 5.
    await activatePassword(page, activationPath, DEFAULT_PILOT_PASSWORD)
  })

  test("record branchA id, add a second branch (multi-branch is central to this phase), and disable the Assets module for the later entitlement/security scenario", async ({ page }) => {
    test.setTimeout(120_000)
    fixture = patchFixture({})
    await loginAsPlatformOperator(page)
    await page.goto(fixture.organizationLink)

    // Assets is enabled by the Enterprise plan's defaults but isn't part of
    // this pilot's actual UAT scope (P5.3 §17 explicitly wants ONE disabled
    // optional module to exercise the entitlement/security path) — disabling
    // it here, once, up front, means every later stage's entitlement checks
    // are against a real, stable, already-disabled module rather than one
    // toggled mid-flow.
    const assetsRow = page.locator("label.rounded-md.border", { hasText: "Assets" })
    const assetsCheckbox = assetsRow.getByRole("checkbox")
    if ((await assetsCheckbox.getAttribute("aria-checked")) === "true") {
      await assetsCheckbox.click()
      await page.waitForTimeout(500)
    }

    await loginAsClinicUser(page, fixture.users.superAdmin.email, fixture.users.superAdmin.password)
    await page.goto("/admin/settings")
    // Record branch A's real id from the branches table link/row before
    // adding branch B, so later stages can address either branch precisely.
    const branchARow = page.getByRole("row", { name: new RegExp(fixture.branchA.name) })
    await expect(branchARow).toBeVisible({ timeout: 10_000 })

    await page.getByRole("button", { name: "Add branch" }).click()
    // /admin/settings also renders the organization's own Name/Legal name
    // fields elsewhere on the same page (not unmounted behind the dialog),
    // so a page-wide getByLabel("Name") is ambiguous — scope to the dialog.
    const branchDialog = page.getByRole("dialog")
    await branchDialog.getByLabel("Name").fill(fixture.branchB.name)
    await branchDialog.getByLabel("Code").fill(fixture.branchB.code)
    await branchDialog.getByLabel("Timezone (IANA)").fill("Asia/Karachi")
    await branchDialog.getByRole("button", { name: "Create branch" }).click()
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })
    await expect(page.getByText(fixture.branchB.name)).toBeVisible({ timeout: 10_000 })

    // Verify resulting DATABASE state directly (P5.3's own explicit
    // requirement), and capture the real branch ids the UI never exposes as
    // a stable selector — later stages need them for direct-DB reconciliation.
    const branches = await withDb((db) =>
      db.query<{ id: string; code: string; status: string }>(
        `select id, code, status from branch where organization_id = $1 order by created_at asc`,
        [fixture.organizationId]
      )
    )
    expect(branches.rows).toHaveLength(2)
    const branchA = branches.rows.find((b) => b.code === fixture.branchA.code)
    const branchB = branches.rows.find((b) => b.code === fixture.branchB.code)
    expect(branchA, "branch A row must exist in the database with the exact code the form submitted").toBeTruthy()
    expect(branchB, "branch B row must exist in the database with the exact code the form submitted").toBeTruthy()
    expect(branchA!.status).toBe("active")
    expect(branchB!.status).toBe("active")

    patchFixture({ branchA: { ...fixture.branchA, id: branchA!.id }, branchB: { ...fixture.branchB, id: branchB!.id } })
  })

  // Every dialog's fields are scoped to `page.getByRole("dialog")` rather
  // than the bare page — /admin/settings proved that a page-wide
  // getByLabel("Name") can collide with fields rendered elsewhere on the
  // same page outside the dialog; scoping to the dialog avoids that whole
  // class of ambiguity across every form below. Master data is split into
  // one test() per category (rather than one combined test) so each route's
  // own first-visit cold-compile cost gets its own timeout budget instead of
  // accumulating against a single shared one — a combined version of this
  // exact test timed out on /pharmacy purely from carrying forward the
  // budget already spent on services/suppliers/products before it.

  test("master data: services (one billable consultation, one billable procedure)", async ({ page }) => {
    test.setTimeout(90_000)
    fixture = patchFixture({})
    await loginAsClinicUser(page, fixture.users.superAdmin.email, fixture.users.superAdmin.password)
    await page.goto("/services")
    for (const [code, name, category, price] of [
      [`SVC-CONS-${fixture.suffix}`, fixture.services.consultationName, "Consultation", "50"],
      [`SVC-PROC-${fixture.suffix}`, fixture.services.procedureName, "Procedure", "30"],
    ] as const) {
      await page.getByRole("button", { name: "New service" }).click()
      const dlg = page.getByRole("dialog")
      await dlg.getByLabel("Code").fill(code)
      await dlg.getByLabel("Category").fill(category)
      await dlg.getByLabel("Name").fill(name)
      await dlg.getByLabel("Price").fill(price)
      const billable = dlg.getByRole("checkbox", { name: "Billable" })
      if ((await billable.getAttribute("aria-checked")) !== "true") await billable.click()
      await dlg.getByRole("button", { name: "Create service" }).click()
      await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })
      await expect(page.getByText(name)).toBeVisible({ timeout: 10_000 })
    }
  })

  test("master data: supplier (needed before products/medications reference it in opening inventory)", async ({ page }) => {
    test.setTimeout(90_000)
    fixture = patchFixture({})
    await loginAsClinicUser(page, fixture.users.superAdmin.email, fixture.users.superAdmin.password)
    await page.goto("/suppliers")
    await page.getByRole("button", { name: "New supplier" }).click()
    {
      const dlg = page.getByRole("dialog")
      await dlg.getByLabel("Code").fill(fixture.suppliers.supplierACode)
      await dlg.getByLabel("Company").fill(`Pilot Medical Supplies ${fixture.suffix}`)
      await dlg.getByRole("button", { name: "Create supplier" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })
    await expect(page.getByText(fixture.suppliers.supplierACode)).toBeVisible({ timeout: 10_000 })
  })

  test("master data: products (one clinical consumable, one retail item)", async ({ page }) => {
    test.setTimeout(90_000)
    fixture = patchFixture({})
    await loginAsClinicUser(page, fixture.users.superAdmin.email, fixture.users.superAdmin.password)
    await page.goto("/inventory")
    for (const [sku, name] of [
      [fixture.products.consumableSku, fixture.products.consumableName],
      [fixture.products.retailSku, fixture.products.retailName],
    ] as const) {
      await page.getByRole("button", { name: "New product" }).click()
      const dlg = page.getByRole("dialog")
      await dlg.getByLabel("SKU").fill(sku)
      await dlg.getByLabel("Name").fill(name)
      await dlg.getByLabel("Category").fill("General")
      await dlg.getByLabel("Unit").fill("each")
      await dlg.getByLabel("Purchase cost").fill("2")
      await dlg.getByLabel("Selling price").fill("5")
      await dlg.getByRole("button", { name: "Create product" }).click()
      await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })
      await expect(page.getByText(name)).toBeVisible({ timeout: 10_000 })
    }
  })

  test("master data: medications (one requiring prescription, one common OTC-style — both go through the same dispensing flow)", async ({ page }) => {
    test.setTimeout(90_000)
    fixture = patchFixture({})
    await loginAsClinicUser(page, fixture.users.superAdmin.email, fixture.users.superAdmin.password)
    await page.goto("/pharmacy")
    // /pharmacy defaults to the "Dispensing Queue" tab — "New medication"
    // lives under a separate "Medication Catalog" tab (a Radix Tabs
    // component, not a distinct route), which must be selected first.
    await page.getByRole("tab", { name: "Medication Catalog" }).click()
    await expect(page.getByRole("button", { name: "New medication" })).toBeVisible({ timeout: 15_000 })
    for (const [sku, name, strength] of [
      [fixture.medications.medASku, fixture.medications.medAName, "500mg"],
      [fixture.medications.medBSku, fixture.medications.medBName, "500mg"],
    ] as const) {
      await page.getByRole("button", { name: "New medication" }).click()
      const dlg = page.getByRole("dialog")
      await dlg.getByLabel("SKU").fill(sku)
      // getByLabel does substring matching by default — "Name" alone also
      // matches "Generic name", so this needs exact: true.
      await dlg.getByLabel("Name", { exact: true }).fill(name)
      await dlg.getByLabel("Strength").fill(strength)
      await dlg.getByLabel("Dosage form").fill("Tablet")
      await dlg.getByLabel("Unit").fill("tablet")
      await dlg.getByLabel("Purchase cost").fill("1")
      await dlg.getByLabel("Selling price").fill("3")
      await dlg.getByRole("button", { name: "Create medication" }).click()
      await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })
      await expect(page.getByText(name)).toBeVisible({ timeout: 10_000 })
    }
  })

  test("master data: lab test", async ({ page }) => {
    test.setTimeout(90_000)
    fixture = patchFixture({})
    await loginAsClinicUser(page, fixture.users.superAdmin.email, fixture.users.superAdmin.password)
    await page.goto("/laboratory")
    // /laboratory defaults to the "Lab Queue" tab — "New test" lives under
    // the separate "Test Catalog" tab (same Radix Tabs pattern as /pharmacy).
    await page.getByRole("tab", { name: "Test Catalog" }).click()
    await page.getByRole("button", { name: "New test" }).click()
    {
      const dlg = page.getByRole("dialog")
      await dlg.getByLabel("Code").fill(`CBC-${fixture.suffix}`)
      await dlg.getByLabel("Name").fill(fixture.labTests.cbcName)
      await dlg.getByLabel("Category").fill("Hematology")
      await dlg.getByLabel("Specimen type").fill("Whole blood")
      await dlg.getByLabel("Price").fill("15")
      await dlg.getByRole("button", { name: "Create test" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })
    await expect(page.getByText(fixture.labTests.cbcName)).toBeVisible({ timeout: 10_000 })
  })

  test("master data: imaging service", async ({ page }) => {
    test.setTimeout(90_000)
    fixture = patchFixture({})
    await loginAsClinicUser(page, fixture.users.superAdmin.email, fixture.users.superAdmin.password)
    await page.goto("/radiology")
    // Same Radix Tabs pattern as /pharmacy and /laboratory — the catalog
    // form lives under a separate tab from the default queue view.
    await page.getByRole("tab", { name: "Imaging Service Catalog" }).click()
    await page.getByRole("button", { name: "New imaging service" }).click()
    {
      const dlg = page.getByRole("dialog")
      await dlg.getByLabel("Code").fill(`XRAY-${fixture.suffix}`)
      await dlg.getByLabel("Name").fill(fixture.imagingServices.xrayName)
      await dlg.getByLabel("Category (modality)").fill("X-Ray")
      await dlg.getByLabel("Price").fill("40")
      await dlg.getByRole("button", { name: "Create service" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })
    await expect(page.getByText(fixture.imagingServices.xrayName)).toBeVisible({ timeout: 10_000 })
  })

  test("master data: payor, then verify EVERY master-data row created across all the tests above actually exists in the database and record their real ids", async ({ page }) => {
    test.setTimeout(90_000)
    fixture = patchFixture({})
    await loginAsClinicUser(page, fixture.users.superAdmin.email, fixture.users.superAdmin.password)
    // Payors — self-pay is often pre-seeded per organization; add one insurance payor regardless.
    await page.goto("/payors")
    await page.getByRole("button", { name: "New payor" }).click()
    {
      const dlg = page.getByRole("dialog")
      await dlg.getByLabel("Code").fill(`INS-${fixture.suffix}`)
      // exact: true — this dialog also has "Contact name", which a plain
      // substring match on "Name" would collide with.
      await dlg.getByLabel("Name", { exact: true }).fill(fixture.payors.insuranceName)
      await dlg.getByRole("button", { name: "Create payor" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })
    await expect(page.getByText(fixture.payors.insuranceName)).toBeVisible({ timeout: 10_000 })

    // Record real ids directly from the database for everything just created.
    const ids = await withDb((db) =>
      db.query<{ label: string; id: string }>(
        `select 'consultation' as label, id from service where organization_id=$1 and name=$2
         union all select 'procedure', id from service where organization_id=$1 and name=$3
         union all select 'supplier', id from supplier where organization_id=$1 and code=$4
         union all select 'labtest', id from lab_test where organization_id=$1 and name=$5
         union all select 'imaging', id from imaging_service where organization_id=$1 and name=$6
         union all select 'insurance', id from payor where organization_id=$1 and name=$7`,
        [
          fixture.organizationId,
          fixture.services.consultationName,
          fixture.services.procedureName,
          fixture.suppliers.supplierACode,
          fixture.labTests.cbcName,
          fixture.imagingServices.xrayName,
          fixture.payors.insuranceName,
        ]
      )
    )
    const byLabel = Object.fromEntries(ids.rows.map((r) => [r.label, r.id]))
    for (const label of ["consultation", "procedure", "supplier", "labtest", "imaging", "insurance"]) {
      expect(byLabel[label], `${label} must exist in the database after creation via the UI`).toBeTruthy()
    }
    patchFixture({
      services: { ...fixture.services, consultationId: byLabel.consultation, procedureId: byLabel.procedure },
      suppliers: { ...fixture.suppliers, supplierAId: byLabel.supplier },
      labTests: { ...fixture.labTests, cbcId: byLabel.labtest },
      imagingServices: { ...fixture.imagingServices, xrayId: byLabel.imaging },
      payors: { ...fixture.payors, insuranceId: byLabel.insurance },
    })
  })

  test("configure a real Chart of Accounts and Account Mappings — provisioning creates NONE of this automatically (confirmed by inspection), so this reflects a genuine, deliberate implementation step a real pilot clinic would have to take", async ({ page }) => {
    test.setTimeout(150_000)
    fixture = patchFixture({})
    await loginAsClinicUser(page, fixture.users.superAdmin.email, fixture.users.superAdmin.password)
    await page.goto("/accounting")
    // /accounting defaults to the "Overview" tab — "New account" lives
    // under the separate "Chart of Accounts" tab (same Radix Tabs pattern
    // as /pharmacy, /laboratory, /radiology).
    await page.getByRole("tab", { name: "Chart of Accounts" }).click()

    const accountsToCreate: { code: string; name: string; type: string }[] = [
      { code: `${fixture.suffix}-1000`, name: "Cash", type: "asset" },
      { code: `${fixture.suffix}-1100`, name: "Accounts Receivable", type: "asset" },
      { code: `${fixture.suffix}-1200`, name: "Inventory Asset", type: "asset" },
      { code: `${fixture.suffix}-2000`, name: "Accounts Payable", type: "liability" },
      { code: `${fixture.suffix}-2100`, name: "Payroll Payable", type: "liability" },
      { code: `${fixture.suffix}-3000`, name: "Opening Balance Equity", type: "equity" },
      { code: `${fixture.suffix}-4000`, name: "Sales Revenue", type: "revenue" },
      { code: `${fixture.suffix}-5000`, name: "Cost of Goods Sold", type: "expense" },
      { code: `${fixture.suffix}-5100`, name: "Salary Expense", type: "expense" },
      { code: `${fixture.suffix}-5900`, name: "General Expense", type: "expense" },
    ]
    for (const acct of accountsToCreate) {
      await page.getByRole("button", { name: "New account" }).click()
      const dlg = page.getByRole("dialog")
      await dlg.getByLabel("Code").fill(acct.code)
      await dlg.getByLabel("Name").fill(acct.name)
      await dlg.getByRole("combobox", { name: "Type" }).click()
      await page.getByRole("option", { name: acct.type, exact: true }).click()
      await dlg.getByRole("button", { name: "Create account" }).click()
      await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })
      await expect(page.getByText(acct.name).first()).toBeVisible({ timeout: 10_000 })
    }

    // "Set mapping" lives under the separate "Account Mappings" tab.
    await page.getByRole("tab", { name: "Account Mappings" }).click()
    const mappings: { intentLabel: string; accountName: string }[] = [
      { intentLabel: "Cash", accountName: "Cash" },
      { intentLabel: "Accounts Receivable", accountName: "Accounts Receivable" },
      { intentLabel: "Revenue", accountName: "Sales Revenue" },
      { intentLabel: "Inventory Asset", accountName: "Inventory Asset" },
      { intentLabel: "Cost of Goods Sold", accountName: "Cost of Goods Sold" },
      { intentLabel: "Accounts Payable", accountName: "Accounts Payable" },
      { intentLabel: "Expense (Default)", accountName: "General Expense" },
      { intentLabel: "Salary Expense", accountName: "Salary Expense" },
      { intentLabel: "Payroll Payable", accountName: "Payroll Payable" },
      // Needed for goods receipt's automatic posting (goods-receipts.ts's
      // GoodsReceiptCompleted handler) — without it, receiving goods
      // against a PO fails outbox dispatch with "No account mapping
      // configured for 'goods_received_not_invoiced'" and posts no
      // journal at all. A small clinic without a dedicated GR/IR clearing
      // account reasonably posts this straight to Accounts Payable.
      { intentLabel: "Goods Received Not Invoiced", accountName: "Accounts Payable" },
      // Needed for payroll's "mark paid" posting (postPayrollPaid resolves
      // the tender account from paidVia via tenderIntent) whenever a run is
      // paid "via bank" — without it, marking a payroll run paid succeeds
      // in the UI (status flips to "paid") but the settlement journal fails
      // outbox dispatch with "No account mapping configured for 'bank'" and
      // silently posts nothing. No separate bank GL account exists in this
      // pilot's small Chart of Accounts, so bank settlement reasonably
      // posts to the same Cash account as a cash settlement would.
      { intentLabel: "Bank Transfer", accountName: "Cash" },
    ]
    for (const m of mappings) {
      await page.getByRole("button", { name: "Set mapping" }).click()
      const dlg = page.getByRole("dialog")
      await dlg.getByRole("combobox", { name: "Posting intent" }).click()
      await page.getByRole("option", { name: m.intentLabel, exact: true }).click()
      await dlg.getByRole("combobox", { name: "Account" }).click()
      await page.getByRole("option", { name: new RegExp(`— ${m.accountName}$`) }).click()
      await dlg.getByRole("button", { name: "Save mapping" }).click()
      await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })
    }

    const accountRows = await withDb((db) =>
      db.query<{ code: string }>(`select code from chart_of_account where organization_id=$1`, [fixture.organizationId])
    )
    expect(accountRows.rows.length).toBe(accountsToCreate.length)
    const mappingRows = await withDb((db) =>
      db.query<{ intent: string }>(`select intent from account_mapping where organization_id=$1 and branch_id is null`, [fixture.organizationId])
    )
    expect(mappingRows.rows.length).toBe(mappings.length)
  })

  test("verify the communication templates the app's own event handlers require — P5.4 §3 now provisions these automatically at provisioning time (closing the exact gap this test used to have to work around by hand: sendMessage's db.commTemplate.findFirstOrThrow has no seeded fallback, so every appointment booking/cancellation would otherwise dead-letter its patient notification forever)", async ({ page }) => {
    test.setTimeout(60_000)
    fixture = patchFixture({})

    // Every templateKey any event handler or action actually looks up
    // (event-handlers.ts's AppointmentBooked/AppointmentCancelled,
    // communications/actions.ts's reminder/payment-reminder/birthday sends).
    // ensureCommunicationTemplates() (communications/templates.ts) now seeds
    // all 5 automatically from provisionClinic() itself — this test verifies
    // that real provisioning-time behavior rather than creating them by
    // hand, which would now fail on the very first one (the key already
    // exists, @@unique([organizationId, key])).
    const expectedKeys = ["appointment_confirmation", "appointment_cancellation", "appointment_reminder", "payment_reminder", "birthday"]
    const templateRows = await withDb((db) =>
      db.query<{ key: string }>(`select key from comm_template where organization_id=$1 and is_active=true`, [fixture.organizationId])
    )
    expect(templateRows.rows.map((r) => r.key).sort()).toEqual(expectedKeys.sort())

    // Visible in the real clinic UI too, not just the database.
    await loginAsClinicUser(page, fixture.users.superAdmin.email, fixture.users.superAdmin.password)
    await page.goto("/communications")
    // /communications defaults to the "reminders" tab — Templates live
    // under the separate "Templates" tab (same Radix Tabs pattern seen on
    // /pharmacy, /laboratory, /radiology, /accounting, /purchasing).
    await page.getByRole("tab", { name: "Templates" }).click()
    for (const key of expectedKeys) {
      await expect(page.getByText(key, { exact: true })).toBeVisible()
    }
  })

  test("create the full realistic role coverage: 10 users, each with an EXISTING system role and real branch access — doctor2 is deliberately Branch B-only for the multi-branch UAT", async ({ page }) => {
    test.setTimeout(150_000)
    fixture = patchFixture({})
    await loginAsClinicUser(page, fixture.users.superAdmin.email, fixture.users.superAdmin.password)
    await page.goto("/admin/users")

    const toCreate: { first: string; last: string; email: string; role: string; branches: string[] }[] = [
      { first: "Rita", last: "Reception", email: fixture.users.receptionist.email, role: "Receptionist", branches: [fixture.branchA.name] },
      { first: "Dana", last: "Doctor", email: fixture.users.doctor1.email, role: "Doctor", branches: [fixture.branchA.name] },
      { first: "Dev", last: "Doctor", email: fixture.users.doctor2.email, role: "Doctor", branches: [fixture.branchB.name] },
      { first: "Nadia", last: "Nurse", email: fixture.users.nurse.email, role: "Nurse", branches: [fixture.branchA.name] },
      { first: "Pat", last: "Pharmacist", email: fixture.users.pharmacist.email, role: "Pharmacist", branches: [fixture.branchA.name] },
      { first: "Leo", last: "LabTech", email: fixture.users.labTech.email, role: "Laboratory Technician", branches: [fixture.branchA.name] },
      { first: "Rae", last: "RadTech", email: fixture.users.radTech.email, role: "Radiology Technician", branches: [fixture.branchA.name] },
      { first: "Ian", last: "Inventory", email: fixture.users.inventoryMgr.email, role: "Inventory Manager", branches: [fixture.branchA.name, fixture.branchB.name] },
      { first: "Ana", last: "Accountant", email: fixture.users.accountant.email, role: "Accountant", branches: [fixture.branchA.name, fixture.branchB.name] },
      { first: "Hana", last: "HR", email: fixture.users.hrManager.email, role: "HR Manager", branches: [fixture.branchA.name, fixture.branchB.name] },
    ]

    for (const u of toCreate) {
      await page.getByRole("button", { name: "New user" }).click()
      const dlg = page.getByRole("dialog")
      await dlg.getByLabel("First name").fill(u.first)
      await dlg.getByLabel("Last name").fill(u.last)
      await dlg.getByLabel("Email", { exact: true }).fill(u.email)
      await dlg.getByLabel("Temporary password").fill(DEFAULT_PILOT_PASSWORD)
      await dlg.getByLabel(u.role, { exact: true }).check()
      for (const b of u.branches) await dlg.getByLabel(b, { exact: true }).check()
      await dlg.getByRole("button", { name: "Create user" }).click()
      await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })
      await expect(page.getByText(u.email)).toBeVisible({ timeout: 10_000 })
    }

    // Verify resulting database state: every user exists, has exactly the
    // expected role, and exactly the expected branch access rows.
    const rows = await withDb((db) =>
      db.query<{ email: string; role_name: string; branch_count: string }>(
        `select u.email, r.name as role_name, (select count(*) from user_branch_access uba where uba.user_id = u.id)::text as branch_count
         from "user" u
         join user_role ur on ur.user_id = u.id
         join role r on r.id = ur.role_id
         where u.organization_id = $1 and u.email = any($2)`,
        [fixture.organizationId, toCreate.map((u) => u.email)]
      )
    )
    for (const u of toCreate) {
      const row = rows.rows.find((r) => r.email === u.email)
      expect(row, `${u.email} must exist with a role assigned`).toBeTruthy()
      expect(row!.role_name).toBe(u.role)
      expect(Number(row!.branch_count)).toBe(u.branches.length)
    }
  })

  test("create 2 doctor providers and 1 nurse provider, linked to their user logins, each assigned to the branch matching their user's own branch access", async ({ page }) => {
    test.setTimeout(120_000)
    fixture = patchFixture({})
    await loginAsClinicUser(page, fixture.users.superAdmin.email, fixture.users.superAdmin.password)
    await page.goto("/providers")

    const toCreate: { first: string; last: string; userEmail: string; branch: string; fee: string }[] = [
      { first: "Dana", last: "Doctor", userEmail: fixture.users.doctor1.email, branch: fixture.branchA.name, fee: "50" },
      { first: "Dev", last: "Doctor", userEmail: fixture.users.doctor2.email, branch: fixture.branchB.name, fee: "50" },
      { first: "Nadia", last: "Nurse", userEmail: fixture.users.nurse.email, branch: fixture.branchA.name, fee: "0" },
    ]

    for (const p of toCreate) {
      await page.getByRole("button", { name: "New provider" }).click()
      const dlg = page.getByRole("dialog")
      await dlg.getByLabel("First name").fill(p.first)
      await dlg.getByLabel("Last name").fill(p.last)
      if (p.last === "Nurse") {
        await dlg.getByRole("combobox", { name: "Type" }).click()
        await page.getByRole("option", { name: "nurse", exact: true }).click()
      }
      await dlg.getByLabel("Consultation fee").fill(p.fee)
      await dlg.getByRole("combobox", { name: "Linked login (optional)" }).click()
      await page.getByRole("option", { name: new RegExp(p.userEmail) }).click()
      await dlg.getByLabel(p.branch, { exact: true }).check()
      await dlg.getByRole("button", { name: "Create provider" }).click()
      await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })
      await expect(page.getByText(`${p.first} ${p.last}`).first()).toBeVisible({ timeout: 10_000 })
    }

    const rows = await withDb((db) =>
      db.query<{ label: string; id: string }>(
        `select 'doctor1' as label, pr.id from provider pr join "user" u on u.id = pr.user_id where u.email=$1
         union all select 'doctor2', pr.id from provider pr join "user" u on u.id = pr.user_id where u.email=$2
         union all select 'nurse', pr.id from provider pr join "user" u on u.id = pr.user_id where u.email=$3`,
        [fixture.users.doctor1.email, fixture.users.doctor2.email, fixture.users.nurse.email]
      )
    )
    const byLabel = Object.fromEntries(rows.rows.map((r) => [r.label, r.id]))
    for (const label of ["doctor1", "doctor2", "nurse"]) {
      expect(byLabel[label], `${label}'s provider row must exist and be linked to their user login`).toBeTruthy()
    }
    patchFixture({ providers: { doctor1Id: byLabel.doctor1, doctor2Id: byLabel.doctor2, nurseId: byLabel.nurse } })
  })

  test("import opening inventory via the P4.6 CSV import framework — verify it creates real ProductBatch + StockLedgerEntry rows and posts NO accounting journal automatically", async ({ page }) => {
    test.setTimeout(90_000)
    fixture = patchFixture({})
    await loginAsClinicUser(page, fixture.users.superAdmin.email, fixture.users.superAdmin.password)
    await page.goto("/admin/onboarding")

    const csv = [
      "sku,branchCode,batchNumber,quantity,unitCost,expiryDate,supplierCode",
      `${fixture.products.consumableSku},${fixture.branchA.code},BATCH-A-${fixture.suffix},200,2.00,,${fixture.suppliers.supplierACode}`,
      `${fixture.products.retailSku},${fixture.branchA.code},BATCH-B-${fixture.suffix},100,2.50,,${fixture.suppliers.supplierACode}`,
      `${fixture.medications.medASku},${fixture.branchA.code},BATCH-C-${fixture.suffix},150,1.00,2028-12-31,${fixture.suppliers.supplierACode}`,
      `${fixture.medications.medBSku},${fixture.branchA.code},BATCH-D-${fixture.suffix},300,0.50,2028-12-31,${fixture.suppliers.supplierACode}`,
      // A near-expiry batch for FEFO testing later (expires soon but not in the past).
      `${fixture.medications.medASku},${fixture.branchA.code},BATCH-C2-${fixture.suffix},20,1.10,2026-10-15,${fixture.suppliers.supplierACode}`,
    ].join("\n")

    // Scoped to the exact per-importer row class (admin/onboarding/page.tsx's
    // own "flex items-center justify-between rounded-md border border-border
    // p-3" div) — a bare `div`/hasText locator matches every ancestor whose
    // text also contains "Opening Inventory" (Card, CardContent, page
    // wrapper), not just the one specific row.
    const openingInventoryRow = page.locator("div.flex.items-center.justify-between.rounded-md.border.border-border", { hasText: "Opening Inventory" })
    await openingInventoryRow.getByRole("button", { name: "Import" }).click()
    const dlg = page.getByRole("dialog")
    await dlg.locator('input[type="file"]').setInputFiles({ name: "opening-inventory.csv", mimeType: "text/csv", buffer: Buffer.from(csv) })
    await dlg.getByRole("button", { name: "Validate (dry run)" }).click()
    await expect(dlg.getByText(/Step 3 — review before committing/i)).toBeVisible({ timeout: 15_000 })
    await expect(dlg.getByText("5", { exact: true }).first()).toBeVisible() // totalRows stat tile

    const confirmCheckbox = dlg.locator('input[type="checkbox"]')
    await confirmCheckbox.check()
    await dlg.getByRole("button", { name: /^Commit \d+ row\(s\)$/ }).click()
    await expect(dlg.getByText(/Imported 5 row\(s\)/i)).toBeVisible({ timeout: 15_000 })

    // Verify resulting DATABASE state directly, and specifically that NO
    // Journal was created by this import — P5.3's own explicit requirement.
    const batches = await withDb((db) =>
      db.query<{ count: string }>(`select count(*)::text from product_batch where organization_id=$1`, [fixture.organizationId])
    )
    expect(Number(batches.rows[0].count)).toBe(5)
    const ledgerEntries = await withDb((db) =>
      db.query<{ count: string }>(`select count(*)::text from stock_ledger_entry where organization_id=$1 and transaction_type='purchase'`, [fixture.organizationId])
    )
    expect(Number(ledgerEntries.rows[0].count)).toBe(5)
    const journals = await withDb((db) =>
      db.query<{ count: string }>(`select count(*)::text from journal where organization_id=$1`, [fixture.organizationId])
    )
    expect(Number(journals.rows[0].count)).toBe(0)
  })

  test("create a treatment package bundling the consultation service — needed for the packages UAT stage", async ({ page }) => {
    test.setTimeout(90_000)
    fixture = patchFixture({})
    await loginAsClinicUser(page, fixture.users.superAdmin.email, fixture.users.superAdmin.password)
    await page.goto("/packages")

    const packageName = `Wellness Package ${fixture.suffix}`
    await page.getByRole("button", { name: "New package" }).click()
    const dlg = page.getByRole("dialog")
    await dlg.getByLabel("Code").fill(`PKG-${fixture.suffix}`)
    await dlg.getByLabel("Name").fill(packageName)
    await dlg.getByLabel("Price").fill("200")
    await dlg.getByLabel("Validity (days)").fill("90")
    // The line-item row's Select has no accessible label (placeholder
    // "Service" only) — scope to the dialog and pick the first such combobox.
    await dlg.getByRole("combobox").first().click()
    await page.getByRole("option", { name: fixture.services.consultationName }).click()
    await dlg.getByPlaceholder("Sessions").first().fill("5")
    await dlg.getByRole("button", { name: "Create package" }).click()
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })
    await expect(page.getByText(packageName)).toBeVisible({ timeout: 10_000 })

    const pkg = await withDb((db) =>
      db.query<{ id: string }>(`select id from package where organization_id=$1 and name=$2`, [fixture.organizationId, packageName])
    )
    expect(pkg.rows[0]?.id, "package must exist in the database").toBeTruthy()
    patchFixture({ packages: { basicPackageId: pkg.rows[0].id, basicPackageName: packageName } })
  })

  test("complete every required onboarding checklist item and start a Pilot UAT cycle (platform operator side) — mirrors P5.2's own proven onboarding/UAT workspace flow", async ({ page }) => {
    test.setTimeout(180_000)
    fixture = patchFixture({})
    await loginAsPlatformOperator(page)
    await page.goto(`${fixture.organizationLink}/onboarding`)
    await expect(page.getByRole("heading", { name: /Onboarding/ })).toBeVisible()

    const updateButtons = page.getByRole("button", { name: "Update" })
    const updateCount = await updateButtons.count()
    for (let i = 0; i < updateCount; i++) {
      await updateButtons.nth(i).click()
      const dlg = page.getByRole("dialog")
      const statusSelect = dlg.getByRole("combobox", { name: "Status" })
      await statusSelect.click()
      await page.getByRole("option", { name: "completed", exact: true }).click()
      await dlg.getByRole("button", { name: "Save" }).click()
      await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })
    }
    await expect(page.getByText(/(\d+) \/ \1 required items complete/)).toBeVisible()

    await page.goto(`${fixture.organizationLink}/uat`)
    await page.getByRole("button", { name: "New UAT cycle" }).click()
    {
      const dlg = page.getByRole("dialog")
      await dlg.getByLabel("Cycle label").fill("Pilot Cycle 1 — Full Clinic Day")
      await dlg.getByLabel("Tester").fill("P5.3 UAT Team")
      await dlg.getByRole("button", { name: "Start cycle" }).click()
    }
    await expect(page.getByText("Pilot Cycle 1")).toBeVisible({ timeout: 10_000 })

    const checklistCount = await withDb((db) =>
      db.query<{ total: string; complete: string }>(
        `select count(*)::text as total, count(*) filter (where status in ('completed','waived'))::text as complete
         from onboarding_checklist_item where organization_id=$1 and required=true`,
        [fixture.organizationId]
      )
    )
    expect(checklistCount.rows[0].total).toBe(checklistCount.rows[0].complete)

    const uat = await withDb((db) =>
      db.query<{ id: string }>(`select id from pilot_uat where organization_id=$1 order by created_at desc limit 1`, [fixture.organizationId])
    )
    expect(uat.rows[0]?.id, "a PilotUat cycle must exist in the database").toBeTruthy()
  })
})
