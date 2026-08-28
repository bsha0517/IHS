import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { closePeriod, reopenPeriod } from "@/lib/domains/accounting/periods"
import { createManualJournal } from "@/lib/domains/accounting/journals"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P1 §31: basic financial period control. `postJournal` (posting-service.ts,
 * the single chokepoint every posting function funnels through) calls
 * `assertPeriodOpen` before writing anything — exercised here through
 * `createManualJournal`, the one path where a caller can pick an arbitrary
 * `journalDate`, since every system-generated posting always dates itself
 * `new Date()` (today, necessarily in whatever period is currently open).
 */
const TIMEOUT = 60000

describe("P1 §31: financial period control", () => {
  let organizationId: string
  let branchId: string
  let userId: string
  let expenseAccountId: string
  let cashAccountId: string
  const periodIds: string[] = []
  const journalIds: string[] = []

  function session(): SessionContext {
    return {
      sessionId: "test-accounting-period-control",
      user: { id: userId, organizationId, email: "period-control-test@test.local", firstName: "Period", lastName: "Test" },
      activeBranchId: branchId,
      branchIds: [branchId],
      permissions: new Set(["accounting.post", "accounting.period.manage"]),
      roleNames: ["Super Admin"],
    }
  }

  // A safely-in-the-past month unlikely to already have a real closed-period
  // row from any other test or real usage of this shared dev org.
  const TEST_YEAR = 2019
  const TEST_MONTH = 6

  async function postManualJournalOn(journalDate: Date) {
    const journal = await createManualJournal(session(), {
      branchId,
      journalDate,
      description: "Period control test entry",
      lines: [
        { accountId: expenseAccountId, debit: 10, credit: 0 },
        { accountId: cashAccountId, debit: 0, credit: 10 },
      ],
    })
    journalIds.push(journal.id)
    return journal
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id
    const user = await db.user.findFirstOrThrow({ where: { organizationId } })
    userId = user.id
    const [expense, cash] = await Promise.all([
      db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "5000" } }),
      db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "1000" } }),
    ])
    expenseAccountId = expense.id
    cashAccountId = cash.id
  }, TIMEOUT)

  afterAll(async () => {
    await db.journalLine.deleteMany({ where: { journalId: { in: journalIds } } })
    await db.journal.deleteMany({ where: { id: { in: journalIds } } })
    await db.accountingPeriod.deleteMany({ where: { id: { in: periodIds } } })
    await db.$disconnect()
  }, TIMEOUT)

  it("a month with no AccountingPeriod row is implicitly open — posting into it succeeds normally", async () => {
    const journal = await postManualJournalOn(new Date(Date.UTC(TEST_YEAR, TEST_MONTH - 1, 15)))
    expect(journal.id).toBeDefined()
  }, TIMEOUT)

  it("closing a period blocks posting into it, and reopening allows it again", async () => {
    const period = await closePeriod(session(), { year: TEST_YEAR, month: TEST_MONTH, reason: "Test: month-end close" })
    periodIds.push(period.id)
    expect(period.status).toBe("closed")

    await expect(postManualJournalOn(new Date(Date.UTC(TEST_YEAR, TEST_MONTH - 1, 20)))).rejects.toThrow(/is closed to posting/)

    // A journal dated in a *different*, still-open month is unaffected.
    const otherMonthJournal = await postManualJournalOn(new Date(Date.UTC(TEST_YEAR, TEST_MONTH, 5)))
    expect(otherMonthJournal.id).toBeDefined()

    const reopened = await reopenPeriod(session(), period.id, "Test: correcting an entry")
    expect(reopened.status).toBe("open")

    const journal = await postManualJournalOn(new Date(Date.UTC(TEST_YEAR, TEST_MONTH - 1, 20)))
    expect(journal.id).toBeDefined()
  }, TIMEOUT)

  it("closing an already-closed period is rejected with a clear error, not a silent no-op", async () => {
    const period = await closePeriod(session(), { year: TEST_YEAR, month: TEST_MONTH + 1, reason: "Test: first close" })
    periodIds.push(period.id)
    await expect(closePeriod(session(), { year: TEST_YEAR, month: TEST_MONTH + 1, reason: "Test: second close" })).rejects.toThrow(/already closed/)
  }, TIMEOUT)

  it("reopening a period that isn't closed is rejected", async () => {
    const period = await closePeriod(session(), { year: TEST_YEAR, month: TEST_MONTH + 2, reason: "Test: close then reopen twice" })
    periodIds.push(period.id)
    await reopenPeriod(session(), period.id, "Test: first reopen")
    await expect(reopenPeriod(session(), period.id, "Test: second reopen")).rejects.toThrow(/not closed/)
  }, TIMEOUT)
})
