import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listAccounts } from "@/lib/domains/accounting/chart-of-accounts"
import { listMappings } from "@/lib/domains/accounting/account-mappings"
import { listJournals, trialBalance, incomeStatement, balanceSheet, cashFlow } from "@/lib/domains/accounting/reports"
import { listAccessibleBranches } from "@/lib/domains/billing/cashier"
import { serializeDecimals } from "@/lib/utils/serialize"
import { formatDate, formatDateTime } from "@/lib/utils/dates"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AccountDialog } from "@/app/(dashboard)/accounting/account-dialog"
import { MappingDialog } from "@/app/(dashboard)/accounting/mapping-dialog"
import { ManualJournalDialog } from "@/app/(dashboard)/accounting/manual-journal-dialog"
import { JournalDetailDialog } from "@/app/(dashboard)/accounting/journal-detail-dialog"

export default async function AccountingPage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "accounting.view")) redirect("/dashboard")

  const canManageAccounts = can(session, "chart_of_account.manage")
  const canManageMappings = can(session, "account_mapping.manage")
  const canPost = can(session, "accounting.post")

  const [accounts, mappings, journals, trial, income, sheet, flow, branches] = await Promise.all([
    listAccounts(session),
    listMappings(session),
    listJournals(session),
    trialBalance(session),
    incomeStatement(session),
    balanceSheet(session),
    cashFlow(session),
    listAccessibleBranches(session),
  ])

  const accountOptions = accounts.map((a) => ({ id: a.id, code: a.code, name: a.name }))
  const branchOptions = branches.map((b) => ({ id: b.id, name: b.name }))

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Accounting</h1>
        {canPost && <ManualJournalDialog accounts={accountOptions} branches={branchOptions} />}
      </div>

      <Tabs defaultValue="accounts">
        <TabsList className="flex-wrap">
          <TabsTrigger value="accounts">Chart of Accounts</TabsTrigger>
          {canManageMappings && <TabsTrigger value="mappings">Account Mappings</TabsTrigger>}
          <TabsTrigger value="journals">Journals</TabsTrigger>
          <TabsTrigger value="trial-balance">Trial Balance</TabsTrigger>
          <TabsTrigger value="income-statement">Income Statement</TabsTrigger>
          <TabsTrigger value="balance-sheet">Balance Sheet</TabsTrigger>
          <TabsTrigger value="cash-flow">Cash Flow</TabsTrigger>
        </TabsList>

        <TabsContent value="accounts" className="grid gap-4">
          {canManageAccounts && (
            <div className="flex justify-end">
              <AccountDialog accounts={accountOptions} />
            </div>
          )}
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Parent</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accounts.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground">
                        No accounts yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {accounts.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="font-medium">{a.code}</TableCell>
                      <TableCell>{a.name}</TableCell>
                      <TableCell className="capitalize">{a.type}</TableCell>
                      <TableCell>{accounts.find((p) => p.id === a.parentAccountId)?.name ?? "—"}</TableCell>
                      <TableCell>
                        {canManageAccounts && (
                          <AccountDialog
                            accounts={accountOptions}
                            existing={{ id: a.id, code: a.code, name: a.name, type: a.type, parentAccountId: a.parentAccountId }}
                          />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {canManageMappings && (
          <TabsContent value="mappings" className="grid gap-4">
            <div className="flex justify-end">
              <MappingDialog accounts={accountOptions} branches={branchOptions} />
            </div>
            <Card>
              <CardContent className="pt-6">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Intent</TableHead>
                      <TableHead>Branch</TableHead>
                      <TableHead>Account</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {mappings.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={3} className="text-center text-muted-foreground">
                          No mappings configured.
                        </TableCell>
                      </TableRow>
                    )}
                    {mappings.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="capitalize">{m.intent.replace(/_/g, " ")}</TableCell>
                        <TableCell>{m.branch?.name ?? <Badge variant="outline">org default</Badge>}</TableCell>
                        <TableCell>
                          {m.account.code} — {m.account.name}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        )}

        <TabsContent value="journals" className="grid gap-4">
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Branch</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {journals.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground">
                        No journals posted yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {journals.map((j) => (
                    <TableRow key={j.id}>
                      <TableCell className="font-medium">{j.journalNumber}</TableCell>
                      <TableCell>{formatDateTime(j.journalDate)}</TableCell>
                      <TableCell>{j.branch.name}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{j.referenceType.replace(/_/g, " ")}</Badge>
                      </TableCell>
                      <TableCell>{j.description}</TableCell>
                      <TableCell>
                        {/* serializeDecimals converts debit/credit to plain numbers at runtime; JournalLine's prop type reflects that post-conversion shape. */}
                        <JournalDetailDialog
                          journalNumber={j.journalNumber}
                          description={j.description}
                          lines={serializeDecimals(j.lines) as unknown as { id: string; account: { code: string; name: string }; debit: number; credit: number; description: string | null }[]}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="trial-balance" className="grid gap-4">
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead className="text-right">Debit</TableHead>
                    <TableHead className="text-right">Credit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {trial.lines.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground">
                        No activity yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {trial.lines.map((l) => (
                    <TableRow key={l.accountId}>
                      <TableCell className="font-medium">{l.code}</TableCell>
                      <TableCell>{l.name}</TableCell>
                      <TableCell className="text-right">{l.debit > 0 ? l.debit.toFixed(2) : ""}</TableCell>
                      <TableCell className="text-right">{l.credit > 0 ? l.credit.toFixed(2) : ""}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="font-medium">
                    <TableCell colSpan={2}>Total</TableCell>
                    <TableCell className="text-right">{trial.totalDebit.toFixed(2)}</TableCell>
                    <TableCell className="text-right">{trial.totalCredit.toFixed(2)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
              {!trial.isBalanced && trial.lines.length > 0 && (
                <p className="mt-2 text-xs text-destructive">Trial balance is out of balance — this should never happen; investigate immediately.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="income-statement" className="grid gap-4">
          <Card>
            <CardContent className="grid gap-6 pt-6">
              <div>
                <h3 className="mb-2 text-sm font-medium">Revenue</h3>
                <Table>
                  <TableBody>
                    {income.revenueLines.map((l) => (
                      <TableRow key={l.code}>
                        <TableCell>
                          {l.code} — {l.name}
                        </TableCell>
                        <TableCell className="text-right">{l.amount.toFixed(2)}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="font-medium">
                      <TableCell>Total Revenue</TableCell>
                      <TableCell className="text-right">{income.totalRevenue.toFixed(2)}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
              <div>
                <h3 className="mb-2 text-sm font-medium">Expenses</h3>
                <Table>
                  <TableBody>
                    {income.expenseLines.map((l) => (
                      <TableRow key={l.code}>
                        <TableCell>
                          {l.code} — {l.name}
                        </TableCell>
                        <TableCell className="text-right">{l.amount.toFixed(2)}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="font-medium">
                      <TableCell>Total Expenses</TableCell>
                      <TableCell className="text-right">{income.totalExpense.toFixed(2)}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
              <div className="border-t pt-4 text-right text-base font-semibold">Net Income: {income.netIncome.toFixed(2)}</div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="balance-sheet" className="grid gap-4">
          <Card>
            <CardContent className="grid gap-6 pt-6">
              <div>
                <h3 className="mb-2 text-sm font-medium">Assets</h3>
                <Table>
                  <TableBody>
                    {sheet.assetLines.map((l) => (
                      <TableRow key={l.code}>
                        <TableCell>
                          {l.code} — {l.name}
                        </TableCell>
                        <TableCell className="text-right">{l.amount.toFixed(2)}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="font-medium">
                      <TableCell>Total Assets</TableCell>
                      <TableCell className="text-right">{sheet.totalAssets.toFixed(2)}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
              <div>
                <h3 className="mb-2 text-sm font-medium">Liabilities</h3>
                <Table>
                  <TableBody>
                    {sheet.liabilityLines.map((l) => (
                      <TableRow key={l.code}>
                        <TableCell>
                          {l.code} — {l.name}
                        </TableCell>
                        <TableCell className="text-right">{l.amount.toFixed(2)}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="font-medium">
                      <TableCell>Total Liabilities</TableCell>
                      <TableCell className="text-right">{sheet.totalLiabilities.toFixed(2)}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
              <div>
                <h3 className="mb-2 text-sm font-medium">Equity</h3>
                <Table>
                  <TableBody>
                    {sheet.equityLines.map((l) => (
                      <TableRow key={l.code}>
                        <TableCell>{l.name}</TableCell>
                        <TableCell className="text-right">{l.amount.toFixed(2)}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="font-medium">
                      <TableCell>Total Equity</TableCell>
                      <TableCell className="text-right">{sheet.totalEquity.toFixed(2)}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
              {!sheet.isBalanced && (
                <p className="text-xs text-destructive">Assets ≠ Liabilities + Equity — this should never happen; investigate immediately.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="cash-flow" className="grid gap-4">
          <Card>
            <CardContent className="grid gap-6 pt-6">
              <div>
                <h3 className="mb-2 text-sm font-medium">Inflows</h3>
                <Table>
                  <TableBody>
                    {flow.inflows.length === 0 && (
                      <TableRow>
                        <TableCell className="text-muted-foreground">No cash inflows yet.</TableCell>
                      </TableRow>
                    )}
                    {flow.inflows.map((l, i) => (
                      <TableRow key={i}>
                        <TableCell>{formatDate(l.date)}</TableCell>
                        <TableCell>{l.description}</TableCell>
                        <TableCell className="text-right">{l.amount.toFixed(2)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div>
                <h3 className="mb-2 text-sm font-medium">Outflows</h3>
                <Table>
                  <TableBody>
                    {flow.outflows.length === 0 && (
                      <TableRow>
                        <TableCell className="text-muted-foreground">No cash outflows yet.</TableCell>
                      </TableRow>
                    )}
                    {flow.outflows.map((l, i) => (
                      <TableRow key={i}>
                        <TableCell>{formatDate(l.date)}</TableCell>
                        <TableCell>{l.description}</TableCell>
                        <TableCell className="text-right">{l.amount.toFixed(2)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="border-t pt-4 text-right text-base font-semibold">Net Change in Cash: {flow.netChange.toFixed(2)}</div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
