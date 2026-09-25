import { test, expect } from "@playwright/test"
import { loginAsClinicUser, readFixture, withDb, type PilotFixture } from "./fixtures"

/**
 * P5.3 Step 10 — inventory/procurement UAT: Purchase Request → approval →
 * Purchase Order → Goods Receipt → real ProductBatch/StockLedgerEntry rows
 * → automatic accounting posting. Run entirely by the inventory manager
 * (who, per the role catalog, can both create AND approve a PR — a real,
 * confirmed self-approval path in a small clinic with one inventory role).
 */
test.describe.serial("P5.3 Inventory / Procurement UAT", () => {
  let fixture: PilotFixture
  let purchaseOrderId: string

  test("create and approve a purchase request for the consumable product, then issue a purchase order from it", async ({ page }) => {
    test.setTimeout(120_000)
    fixture = readFixture()
    await loginAsClinicUser(page, fixture.users.inventoryMgr.email, fixture.users.inventoryMgr.password)
    await page.goto("/purchasing")

    // product_batch has no "quantity" column — current balance per product
    // is always derived from stock_ledger_entry (the real source of truth).
    const stockBefore = await withDb((db) =>
      db.query<{ total: string }>(
        `select coalesce(sum(quantity),0)::text as total from stock_ledger_entry where organization_id=$1 and product_id=(select id from product where organization_id=$1 and sku=$2)`,
        [fixture.organizationId, fixture.products.consumableSku]
      )
    )

    await page.getByRole("button", { name: "New request" }).click()
    {
      const dlg = page.getByRole("dialog")
      await dlg.getByRole("combobox", { name: "Branch" }).click()
      await page.getByRole("option", { name: fixture.branchA.name }).click()
      await dlg.getByRole("combobox").last().click()
      await page.getByRole("option", { name: new RegExp(fixture.products.consumableName) }).click()
      await dlg.getByPlaceholder("Qty").fill("100")
      await dlg.getByRole("button", { name: "Submit request" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })

    const pr = await withDb((db) =>
      db.query<{ id: string; status: string }>(`select id, status from purchase_request where organization_id=$1 order by created_at desc limit 1`, [fixture.organizationId])
    )
    expect(pr.rows[0].status).toBe("submitted")
    const prId = pr.rows[0].id

    await page.goto(`/purchasing/${prId}`).catch(() => {})
    // If there's no dedicated detail route, the approve action is available
    // from the list itself — fall back to the list page.
    if (page.url().includes("404") || !(await page.getByRole("button", { name: "Approve" }).isVisible().catch(() => false))) {
      await page.goto("/purchasing")
    }
    await page.getByRole("button", { name: "Approve" }).first().click()
    await expect(page.getByText(/approved/i).first()).toBeVisible({ timeout: 10_000 })

    // Not /purchasing/orders — there's no orders LIST route (that path is
    // an explicit "Scheduled in a later build phase" placeholder). Only
    // /purchasing (the main page, already here) and /purchasing/orders/[id]
    // (a detail page) exist; "New order" is a dialog trigger on /purchasing
    // itself (new-order-dialog.tsx), under the same Radix Tabs pattern seen
    // on /pharmacy, /laboratory, /radiology, /accounting — the page defaults
    // to the "Purchase Requests" tab, not "Purchase Orders".
    await page.getByRole("tab", { name: "Purchase Orders" }).click()
    await page.getByRole("button", { name: "New order" }).click()
    {
      const dlg = page.getByRole("dialog")
      const fromRequest = dlg.getByRole("combobox", { name: "From approved request (optional)" })
      if (await fromRequest.isVisible().catch(() => false)) {
        await fromRequest.click()
        await page.getByRole("option", { name: new RegExp(fixture.products.consumableName) }).click()
      }
      await dlg.getByRole("combobox", { name: "Branch" }).click()
      await page.getByRole("option", { name: fixture.branchA.name }).click()
      // The Supplier option list shows each supplier's company name, not
      // its code — the fixture only tracks supplierACode, and this pilot
      // org only ever creates one supplier, so picking the sole option is
      // both correct and unambiguous.
      await dlg.getByRole("combobox", { name: "Supplier" }).click()
      await page.getByRole("option").first().click()
      // Always fill the product line manually rather than relying on "From
      // approved request" auto-fill — its own combobox stayed at "None —
      // build manually" in practice, since its options are keyed by PR
      // identifiers, not anything this test's fixture data can reliably
      // match. The product Select itself has no accessible name (no
      // htmlFor/aria-label — same unlabeled-field gap seen elsewhere), so
      // getByPlaceholder("Product") never matches it; it's the only
      // unnamed combobox in this dialog.
      await dlg.getByRole("combobox").filter({ hasText: "Product" }).click()
      await page.getByRole("option", { name: new RegExp(fixture.products.consumableName) }).click()
      await dlg.getByPlaceholder("Qty").fill("100")
      await dlg.getByPlaceholder("Cost").fill("2")
      await dlg.getByRole("button", { name: "Issue order" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })

    const po = await withDb((db) => db.query<{ id: string }>(`select id from purchase_order where organization_id=$1 order by created_at desc limit 1`, [fixture.organizationId]))
    purchaseOrderId = po.rows[0].id
    expect(purchaseOrderId).toBeTruthy()
  })

  test("receive goods against the purchase order — verify a real batch + stock ledger entry, updated PO status, and an automatic accounting journal (no manual posting step)", async ({ page }) => {
    test.setTimeout(120_000)
    fixture = readFixture()
    await loginAsClinicUser(page, fixture.users.inventoryMgr.email, fixture.users.inventoryMgr.password)
    await page.goto(`/purchasing/orders/${purchaseOrderId}`)
    // Not a semantic "Order" heading — matches the same non-heading detail-
    // card pattern found on lab/radiology order pages. "Receive goods" is
    // the real, specific signal the page loaded.
    await expect(page.getByRole("button", { name: "Receive goods" })).toBeVisible({ timeout: 15_000 })

    await page.getByRole("button", { name: "Receive goods" }).click()
    {
      const dlg = page.getByRole("dialog")
      // Not getByLabel — receive-dialog.tsx's per-field <Label> elements
      // have no htmlFor/id tying them to their <Input>s (the same
      // unlabeled-field gap found in the prescription and payment
      // dialogs). Scoped by each field's own "grid gap-1" wrapper div.
      function field(label: string) {
        return dlg.locator("div.grid.gap-1", { hasText: label }).locator("input")
      }
      await field("Batch number").fill(`PO-BATCH-${fixture.suffix}`)
      await field("Qty received").fill("100")
      await field("Unit cost").fill("2")
      await dlg.getByRole("button", { name: "Record receipt" }).click()
    }
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 })

    const batch = await withDb((db) =>
      db.query<{ count: string }>(`select count(*)::text from product_batch where organization_id=$1 and batch_number=$2`, [fixture.organizationId, `PO-BATCH-${fixture.suffix}`])
    )
    expect(Number(batch.rows[0].count)).toBe(1)

    const ledger = await withDb((db) =>
      db.query<{ count: string }>(
        `select count(*)::text from stock_ledger_entry sle join product_batch pb on pb.id=sle.batch_id where pb.batch_number=$1 and sle.transaction_type='purchase'`,
        [`PO-BATCH-${fixture.suffix}`]
      )
    )
    expect(Number(ledger.rows[0].count)).toBeGreaterThanOrEqual(1)

    const poStatus = await withDb((db) => db.query<{ status: string }>(`select status from purchase_order where id=$1`, [purchaseOrderId]))
    expect(["partially_received", "received"]).toContain(poStatus.rows[0].status)

    const goodsReceipt = await withDb((db) =>
      db.query<{ id: string }>(`select id from goods_receipt where organization_id=$1 and purchase_order_id=$2 order by received_at desc limit 1`, [fixture.organizationId, purchaseOrderId])
    )
    const journal = await withDb((db) =>
      db.query<{ debit_total: string; credit_total: string }>(
        `select (select coalesce(sum(debit),0) from journal_line where journal_id=j.id)::text as debit_total,
                (select coalesce(sum(credit),0) from journal_line where journal_id=j.id)::text as credit_total
         from journal j where j.organization_id=$1 and j.reference_id=$2`,
        [fixture.organizationId, goodsReceipt.rows[0].id]
      )
    )
    expect(journal.rows.length, "goods receipt must post its own journal automatically, with no separate manual posting step").toBeGreaterThanOrEqual(1)
    expect(journal.rows[0].debit_total).toBe(journal.rows[0].credit_total)
  })
})
