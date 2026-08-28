import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"

/**
 * Real integration test against the actual database — not a mock. Confirms
 * the DEFERRABLE CONSTRAINT TRIGGER `journal_line_balance_check` (Phase 6,
 * see DATABASE.md) genuinely rejects an unbalanced journal at commit, the
 * same invariant every phase since 6 has re-verified by hand via a
 * standalone script (see PROJECT_STATUS.md's Phase 6 Tests). This is that
 * verification made permanent and repeatable instead of re-run ad hoc.
 */
describe("journal_line_balance_check DB trigger", () => {
  let organizationId: string
  let branchId: string
  let cashAccountId: string
  let expenseAccountId: string
  const createdJournalIds: string[] = []

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow({ include: { organization: true } })
    organizationId = branch.organizationId
    branchId = branch.id
    const cash = await db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "1000" } })
    const expense = await db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "5000" } })
    cashAccountId = cash.id
    expenseAccountId = expense.id
  })

  afterAll(async () => {
    // Only the balanced journal actually commits (the unbalanced one rolls back on its own) — clean it up.
    // JournalLine.journal is now onDelete: Restrict (P0-05), so children must
    // be deleted before the parent — cascade no longer does this for us.
    if (createdJournalIds.length > 0) {
      await db.journalLine.deleteMany({ where: { journalId: { in: createdJournalIds } } })
      await db.journal.deleteMany({ where: { id: { in: createdJournalIds } } })
    }
    await db.$disconnect()
  }, 20000)

  it("rejects an unbalanced journal (Dr 100 / Cr 50) at commit, not silently", async () => {
    await expect(
      db.$transaction(async (tx) => {
        const journal = await tx.journal.create({
          data: {
            organizationId,
            branchId,
            journalNumber: `TEST-UNBAL-${Date.now()}`,
            journalDate: new Date(),
            referenceType: "vitest_integration_test",
            description: "Phase 14 integration test — deliberately unbalanced",
          },
        })
        await tx.journalLine.createMany({
          data: [
            { journalId: journal.id, accountId: expenseAccountId, debit: 100, credit: 0 },
            { journalId: journal.id, accountId: cashAccountId, debit: 0, credit: 50 },
          ],
        })
      })
    ).rejects.toThrow()
  })

  it("accepts a balanced journal (Dr 100 / Cr 100)", async () => {
    const journalId = await db.$transaction(async (tx) => {
      const journal = await tx.journal.create({
        data: {
          organizationId,
          branchId,
          journalNumber: `TEST-BAL-${Date.now()}`,
          journalDate: new Date(),
          referenceType: "vitest_integration_test",
          description: "Phase 14 integration test — balanced",
        },
      })
      await tx.journalLine.createMany({
        data: [
          { journalId: journal.id, accountId: expenseAccountId, debit: 100, credit: 0 },
          { journalId: journal.id, accountId: cashAccountId, debit: 0, credit: 100 },
        ],
      })
      return journal.id
    })
    createdJournalIds.push(journalId)

    const lines = await db.journalLine.findMany({ where: { journalId } })
    expect(lines).toHaveLength(2)
  })
})
