import { redirect } from "next/navigation"
import Link from "next/link"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listAccounts } from "@/lib/domains/accounting/chart-of-accounts"
import { listMappings } from "@/lib/domains/accounting/account-mappings"
import { listJournals, getFinancialStatements, cashFlow } from "@/lib/domains/accounting/reports"
import { listAccountingPeriods } from "@/lib/domains/accounting/periods"
import { listAccessibleBranches } from "@/lib/domains/billing/cashier"
import { REFERENCE_TYPE_LABELS } from "@/lib/domains/accounting/traceability"
import { postingIntents, POSTING_INTENT_LABELS } from "@/lib/domains/accounting/schemas"
import { listAccountingExceptions, accountingEventTypeLabel } from "@/lib/domains/accounting/exceptions"
import { listOutstandingInvoices } from "@/lib/domains/billing/invoices"
import { listOutstandingSupplierInvoices } from "@/lib/domains/procurement/supplier-invoices"
import { serializeDecimals } from "@/lib/utils/serialize"
import { formatDate, formatDateTime } from "@/lib/utils/dates"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PageHeader } from "@/components/ui/page-header"
import { FilterBar, FilterField } from "@/components/ui/filter-bar"
import { AccountDialog } from "@/app/(dashboard)/accounting/account-dialog"
import { MappingDialog } from "@/app/(dashboard)/accounting/mapping-dialog"
import { ManualJournalDialog } from "@/app/(dashboard)/accounting/manual-journal-dialog"
import { JournalDetailDialog } from "@/app/(dashboard)/accounting/journal-detail-dialog"
import { ReverseJournalDialog } from "@/app/(dashboard)/accounting/reverse-journal-dialog"
import { PeriodsPanel } from "@/app/(dashboard)/accounting/periods-panel"
import { ExceptionRetryButton } from "@/app/(dashboard)/accounting/exception-retry-button"
import { ExceptionSweepButton } from "@/app/(dashboard)/accounting/exception-sweep-button"
import { PaginationControls } from "@/components/domain/pagination-controls"

const EXCEPTION_STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "secondary",
  processing: "secondary",
  completed: "outline",
  failed: "default",
  dead_letter: "destructive",
}

export default async function AccountingPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string
    dateFrom?: string
    dateTo?: string
    branchId?: string
    referenceType?: string
    page?: string
    exceptionsPage?: string
    exceptionsStatus?: string
  }>
}) {
  const session = await getCurrentSession()
  if (!session || !can(session, "accounting.view")) redirect("/dashboard")

  const canManageAccounts = can(session, "chart_of_account.manage")
  const canManageMappings = can(session, "account_mapping.manage")
  const canPost = can(session, "accounting.post")
  const canManagePeriods = can(session, "accounting.period.manage")

  const sp = await searchParams
  // P2 §6: date range/branch/reference-type filters for the traceability
  // viewer's Journals tab — listJournals already supported branchId/
  // referenceType server-side; dateFrom/dateTo are new this batch (see
  // that function's own doc comment). Same local-time date-param handling
  // reports/page.tsx already established, not a new convention.
  const journalFilters = {
    branchId: sp.branchId || undefined,
    referenceType: sp.referenceType || undefined,
    dateFrom: sp.dateFrom ? new Date(`${sp.dateFrom}T00:00:00`) : undefined,
    dateTo: sp.dateTo ? new Date(`${sp.dateTo}T23:59:59`) : undefined,
    page: sp.page ? Number(sp.page) : undefined,
  }
  // P2 §9: was `cashFlow(session)` — no date bound at all, so every load of
  // this page fetched every "cash"-account journal line the org has ever
  // posted. Every other report screen in this app already defaults to the
  // current month (see analytics/dashboards.ts's own `monthToDateRange`,
  // and reports/page.tsx's `defaultReportFilters`) — this was the one
  // unbounded exception, not a deliberate "show everything" design.
  const now = new Date()
  const cashFlowRange = { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now }

  // P2 §9: trial balance/income statement/balance sheet share the exact
  // same underlying account-balance aggregation and (here) the same
  // filters (org-wide, all-time) — getFinancialStatements fetches it once
  // instead of the three independent scans this page used to run.
  const [accounts, mappings, journalsResult, statements, flow, branches, periods, exceptionsResult, receivables, payables] = await Promise.all([
    listAccounts(session),
    listMappings(session),
    listJournals(session, journalFilters),
    getFinancialStatements(session),
    cashFlow(session, cashFlowRange),
    listAccessibleBranches(session),
    canManagePeriods ? listAccountingPeriods(session) : Promise.resolve([]),
    // P3.9 §7/§19-20: the accountant landing workspace's own "are there
    // failed postings?" answer, and the Exceptions tab's data — same
    // fetch, not two separate queries (needsAttention comes from the same
    // groupBy the tab's own list uses).
    listAccountingExceptions(session, { status: sp.exceptionsStatus || undefined, page: sp.exceptionsPage ? Number(sp.exceptionsPage) : undefined }),
    listOutstandingInvoices(session, { page: 1 }),
    can(session, "supplier_invoice.manage") ? listOutstandingSupplierInvoices(session, { page: 1 }) : Promise.resolve(null),
  ])
  const { journals, total: journalTotal, page: journalPage, totalPages: journalTotalPages } = journalsResult
  const { trialBalance: trial, incomeStatement: income, balanceSheet: sheet } = statements
  const { events: exceptions, total: exceptionTotal, page: exceptionPage, totalPages: exceptionTotalPages, needsAttention } = exceptionsResult
  const closedPeriodCount = periods.filter((p) => p.status === "closed").length

  const accountOptions = accounts.map((a) => ({ id: a.id, code: a.code, name: a.name }))
  const branchOptions = branches.map((b) => ({ id: b.id, name: b.name }))
  const referenceTypeOptions = Object.entries(REFERENCE_TYPE_LABELS)
  // P3.9 §10: an intent resolves at posting time to its org-wide default
  // (branchId null) unless a branch-specific override exists — so the org
  // default is the one mapping whose absence guarantees a failure for every
  // branch, not just one. Branch-specific gaps aren't flagged here since
  // they silently fall back to the (present) org default, which is by
  // design, not a misconfiguration.
  const configuredOrgWideIntents = new Set(mappings.filter((m) => !m.branchId).map((m) => m.intent))
  const missingIntents = postingIntents.filter((i) => !configuredOrgWideIntents.has(i))

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Accounting" primaryAction={canPost && <ManualJournalDialog accounts={accountOptions} branches={branchOptions} />} />

      <Tabs defaultValue={sp.tab || "overview"}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="accounts">Chart of Accounts</TabsTrigger>
          {canManageMappings && <TabsTrigger value="mappings">Account Mappings</TabsTrigger>}
          <TabsTrigger value="journals">Journals</TabsTrigger>
          <TabsTrigger value="exceptions">
            Exceptions{needsAttention > 0 && ` (${needsAttention})`}
          </TabsTrigger>
          <TabsTrigger value="trial-balance">Trial Balance</TabsTrigger>
          <TabsTrigger value="income-statement">Income Statement</TabsTrigger>
          <TabsTrigger value="balance-sheet">Balance Sheet</TabsTrigger>
          <TabsTrigger value="cash-flow">Cash Flow</TabsTrigger>
          {canManagePeriods && <TabsTrigger value="periods">Periods</TabsTrigger>}
        </TabsList>

        {/* P3.9 §7: the accountant landing workspace — what needs attention, at a glance, before drilling into any one tab. Operational focus (counts + direct links), not an executive BI dashboard. */}
        <TabsContent value="overview" className="grid gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card className={needsAttention > 0 ? "border-destructive/50" : undefined}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Failed postings</CardTitle>
              </CardHeader>
              <CardContent>
                <p className={`text-2xl font-semibold ${needsAttention > 0 ? "text-destructive" : ""}`}>{needsAttention}</p>
                <p className="text-xs text-muted-foreground">event(s) failed or dead-lettered</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Outstanding receivables</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold">{receivables.totalOutstanding.toFixed(2)}</p>
                <p className="text-xs text-muted-foreground">{receivables.total} invoice(s) — <Link href="/receivables" className="underline">view</Link></p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Outstanding payables</CardTitle>
              </CardHeader>
              <CardContent>
                {payables ? (
                  <>
                    <p className="text-2xl font-semibold">{payables.totalOutstanding.toFixed(2)}</p>
                    <p className="text-xs text-muted-foreground">{payables.total} invoice(s) — <Link href="/payables" className="underline">view</Link></p>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">Not available for this role.</p>
                )}
              </CardContent>
            </Card>
            <Card className={missingIntents.length > 0 ? "border-destructive/50" : undefined}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Account mappings</CardTitle>
              </CardHeader>
              <CardContent>
                <p className={`text-2xl font-semibold ${missingIntents.length > 0 ? "text-destructive" : ""}`}>
                  {postingIntents.length - missingIntents.length}/{postingIntents.length}
                </p>
                <p className="text-xs text-muted-foreground">
                  {missingIntents.length > 0 ? `${missingIntents.length} not configured` : "all configured"}
                </p>
              </CardContent>
            </Card>
          </div>
          {closedPeriodCount > 0 && (
            <Card>
              <CardContent className="pt-6 text-sm">
                <span className="font-medium">{closedPeriodCount}</span> financial period{closedPeriodCount === 1 ? " is" : "s are"} currently closed to
                posting.{canManagePeriods && " See the Periods tab to review or reopen."}
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent journals</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Transaction type</TableHead>
                    <TableHead>Description</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {journals.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground">
                        No journals posted yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {journals.slice(0, 8).map((j) => (
                    <TableRow key={j.id}>
                      <TableCell className="font-medium">{j.journalNumber}</TableCell>
                      <TableCell>{formatDateTime(j.journalDate)}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{REFERENCE_TYPE_LABELS[j.referenceType] ?? j.referenceType.replace(/_/g, " ")}</Badge>
                      </TableCell>
                      <TableCell>{j.description}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

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
            {/* P3.9 §10: a posting intent with no org-wide default mapping WILL dead-letter the first
                operational event that needs it — never guessed/auto-selected, but surfaced here so an
                Accountant/Admin can see and fix the gap before it causes a failure, not after. */}
            {missingIntents.length > 0 && (
              <Card className="border-destructive/50">
                <CardContent className="pt-6">
                  <p className="mb-2 text-sm font-medium text-destructive">
                    {missingIntents.length} posting intent{missingIntents.length === 1 ? "" : "s"} with no organization-wide default mapping
                  </p>
                  <p className="mb-3 text-xs text-muted-foreground">
                    Any operational event that needs one of these will fail to post until it&apos;s configured.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {missingIntents.map((i) => (
                      <Badge key={i} variant="destructive">
                        {POSTING_INTENT_LABELS[i]}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
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
                        <TableCell>{POSTING_INTENT_LABELS[m.intent] ?? m.intent.replace(/_/g, " ")}</TableCell>
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
          {/* P2 §6: traceability viewer filters — date range, branch, reference type (Business Transaction kind). GET form, same pattern as reports/page.tsx. */}
          {/* P4.7A.1 §32/§33 — the shared FilterBar shell in place of the ad hoc Card/form pair. */}
          <FilterBar method="get">
                <input type="hidden" name="tab" value="journals" />
                <FilterField label="From" htmlFor="dateFrom">
                  <input id="dateFrom" name="dateFrom" type="date" defaultValue={sp.dateFrom ?? ""} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs" />
                </FilterField>
                <FilterField label="To" htmlFor="dateTo">
                  <input id="dateTo" name="dateTo" type="date" defaultValue={sp.dateTo ?? ""} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs" />
                </FilterField>
                <FilterField label="Branch" htmlFor="branchId">
                  <select id="branchId" name="branchId" defaultValue={sp.branchId ?? ""} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs">
                    <option value="">All branches</option>
                    {branchOptions.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                </FilterField>
                <FilterField label="Transaction type" htmlFor="referenceType">
                  <select id="referenceType" name="referenceType" defaultValue={sp.referenceType ?? ""} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs">
                    <option value="">All types</option>
                    {referenceTypeOptions.map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </FilterField>
                <Button type="submit" variant="secondary">Apply filters</Button>
                {(sp.dateFrom || sp.dateTo || sp.branchId || sp.referenceType) && (
                  <Button type="button" variant="ghost" asChild>
                    <Link href="/accounting?tab=journals">Clear</Link>
                  </Button>
                )}
          </FilterBar>
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Branch</TableHead>
                    <TableHead>Transaction type</TableHead>
                    <TableHead>Posted by</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {journals.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-muted-foreground">
                        No journals match these filters.
                      </TableCell>
                    </TableRow>
                  )}
                  {journals.map((j) => (
                    <TableRow key={j.id}>
                      <TableCell className="font-medium">{j.journalNumber}</TableCell>
                      <TableCell>{formatDateTime(j.journalDate)}</TableCell>
                      <TableCell>{j.branch.name}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{REFERENCE_TYPE_LABELS[j.referenceType] ?? j.referenceType.replace(/_/g, " ")}</Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {j.postedByUser ? `${j.postedByUser.firstName} ${j.postedByUser.lastName}` : "System"}
                      </TableCell>
                      <TableCell>{j.description}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          {/* serializeDecimals converts debit/credit to plain numbers at runtime; JournalLine's prop type reflects that post-conversion shape. */}
                          <JournalDetailDialog
                            journalId={j.id}
                            journalNumber={j.journalNumber}
                            description={j.description}
                            referenceType={j.referenceType}
                            referenceTypeLabel={REFERENCE_TYPE_LABELS[j.referenceType] ?? j.referenceType.replace(/_/g, " ")}
                            branchName={j.branch.name}
                            journalDate={formatDateTime(j.journalDate)}
                            createdAt={formatDateTime(j.createdAt)}
                            postedByName={j.postedByUser ? `${j.postedByUser.firstName} ${j.postedByUser.lastName}` : null}
                            lines={serializeDecimals(j.lines) as unknown as { id: string; account: { code: string; name: string }; debit: number; credit: number; description: string | null }[]}
                          />
                          {/* P1 §24: only a manual journal reverses directly here — a domain-tied one (invoice, refund, ...) goes through its own domain's void/refund workflow instead. */}
                          {canPost && j.referenceType === "manual" && <ReverseJournalDialog journalId={j.id} journalNumber={j.journalNumber} />}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {/* tab forced to "journals" regardless of how sp.tab arrived — Prev/Next must not silently drop the user back onto the Accounts tab when they reached this tab by clicking it rather than submitting the filter form above. */}
              <PaginationControls page={journalPage} totalPages={journalTotalPages} total={journalTotal} basePath="/accounting" searchParams={{ ...sp, tab: "journals" }} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* P3.9 §19-24: a narrowed, accounting-scoped view of the same outbox/system-events queue
            /admin/system-events already shows to Admin — filtered to only the event types that
            actually reach the posting service, gated on accounting.view/accounting.post instead of
            system_events.view/system_events.retry (which Accountant does not hold and should not be
            broad-granted just to see this). Same retry/sweep mechanism, not a second one. */}
        <TabsContent value="exceptions" className="grid gap-4">
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
              <p className="text-sm text-muted-foreground">
                Operational events (invoices, payments, refunds, goods receipts, supplier invoices/payments, product
                sales, inventory adjustments, payroll) that failed to post to the ledger — most often because a
                financial period was closed or an account mapping is missing. A failed event automatically retries on
                its own schedule; <span className="font-medium">dead_letter</span> means it exhausted 3 attempts and
                needs the underlying cause fixed before retrying again.
              </p>
              {canPost && <ExceptionSweepButton />}
            </CardContent>
          </Card>
          <div className="flex gap-2">
            {["", "failed", "dead_letter", "pending", "completed"].map((s) => (
              <Button key={s || "all"} variant={(sp.exceptionsStatus ?? "") === s ? "default" : "outline"} size="sm" asChild>
                <Link href={`/accounting?tab=exceptions${s ? `&exceptionsStatus=${s}` : ""}`}>{s || "All"}</Link>
              </Button>
            ))}
          </div>
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Posting</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Attempts</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Failure reason</TableHead>
                    <TableHead>Next retry</TableHead>
                    {canPost && <TableHead />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {exceptions.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={canPost ? 7 : 6} className="text-center text-muted-foreground">
                        No accounting postings in this status.
                      </TableCell>
                    </TableRow>
                  )}
                  {exceptions.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="font-medium">{accountingEventTypeLabel(e.eventType)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatDateTime(e.createdAt)}</TableCell>
                      <TableCell>{e.attempts}</TableCell>
                      <TableCell>
                        <Badge variant={EXCEPTION_STATUS_VARIANT[e.status] ?? "outline"}>{e.status}</Badge>
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-xs text-muted-foreground" title={e.lastError ?? undefined}>
                        {e.lastError ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {e.nextRetryAt ? formatDateTime(e.nextRetryAt) : "—"}
                      </TableCell>
                      {canPost && (
                        <TableCell>
                          {(e.status === "failed" || e.status === "dead_letter") && <ExceptionRetryButton eventId={e.id} />}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <PaginationControls
                page={exceptionPage}
                totalPages={exceptionTotalPages}
                total={exceptionTotal}
                basePath="/accounting"
                searchParams={{ ...sp, tab: "exceptions", exceptionsPage: String(exceptionPage) }}
                pageParam="exceptionsPage"
              />
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
          <p className="text-sm text-muted-foreground">{formatDate(cashFlowRange.from)} – {formatDate(cashFlowRange.to)} (current month)</p>
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

        {canManagePeriods && (
          <TabsContent value="periods" className="grid gap-4">
            <PeriodsPanel periods={periods} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}
