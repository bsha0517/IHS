import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { getAuthorizedBranchScope, narrowBranchFilter } from "@/lib/platform/branch-scope"
import { assertExportRowLimit } from "@/lib/platform/reports"
import type { SessionContext } from "@/lib/auth/session"
import type { ReportFilters } from "@/lib/domains/analytics/schemas"

/**
 * P4.7 §31/§48 — true "data portability" exports: a structured domain
 * export a clinic can use to move its own data elsewhere, distinct from the
 * report-category CSVs in reports/*.ts (which export what a report screen
 * shows). These deliberately don't reuse a get*Report()'s screen-preview
 * shape — a portability export needs the full, complete field set for its
 * entity, not a report's derived/aggregated view of it.
 */

const PATIENT_MASTER_FIELDS = {
  id: true,
  mrn: true,
  legacyMrn: true,
  firstName: true,
  middleName: true,
  lastName: true,
  dob: true,
  gender: true,
  nationality: true,
  mobile: true,
  whatsapp: true,
  email: true,
  addressLine: true,
  city: true,
  country: true,
  preferredLanguage: true,
  status: true,
  createdAt: true,
  registrationBranch: { select: { name: true } },
} as const

/**
 * P4.7 §48 — Patient Master export. Deliberately operational demographics
 * only, matching §48's own explicit boundary: no passwords/auth data
 * (Patient has none — a Patient is never a login), no access logs, no
 * internal security fields, and — beyond the registration-report shape in
 * reports/patients.ts — this adds contact/address fields but still
 * excludes national ID/passport number (real, sensitive government-ID PII)
 * and every clinical field (diagnoses, notes, orders, results) entirely;
 * clinical portability stays explicitly out of this phase per §49.
 */
export async function exportPatientMasterRows(session: SessionContext, filters: Pick<ReportFilters, "from" | "to" | "branchId"> = { from: new Date(0), to: new Date(), branchId: undefined }) {
  assertCan(session, "patient.view")
  const organizationId = session.user.organizationId
  const scope = getAuthorizedBranchScope(session)
  const branchFilter = narrowBranchFilter(scope, filters.branchId)
  const where = { organizationId, registrationBranchId: branchFilter, createdAt: { gte: filters.from, lte: filters.to } }
  const total = await db.patient.count({ where })
  assertExportRowLimit(total)
  return db.patient.findMany({ where, select: PATIENT_MASTER_FIELDS, orderBy: { createdAt: "asc" } })
}

/**
 * P4.7 §22/§23 — General Ledger Export: one row per journal_line, the real
 * atomic unit of the ledger, joined to its account and parent journal.
 * Reuses the same branch-scoping discipline accounting/reports.ts already
 * established for every other financial report (an explicit requested
 * branch must be within the caller's own access; no request resolves to
 * "every branch" for a non-org-wide session) — implemented here via
 * `narrowBranchFilter` against `journal.branchId` rather than duplicating
 * `resolveReportBranchFilter`'s raw-SQL version, since this is a normal
 * Prisma `findMany`, not the raw aggregate query that function serves.
 */
export async function exportGeneralLedgerRows(session: SessionContext, filters: ReportFilters) {
  assertCan(session, "accounting.view")
  const organizationId = session.user.organizationId
  const scope = getAuthorizedBranchScope(session)
  const branchFilter = narrowBranchFilter(scope, filters.branchId)
  const where = {
    journal: {
      organizationId,
      branchId: branchFilter,
      journalDate: { gte: filters.from, lte: filters.to },
    },
  }
  const total = await db.journalLine.count({ where })
  assertExportRowLimit(total)
  return db.journalLine.findMany({
    where,
    include: { account: { select: { code: true, name: true } }, journal: { select: { journalNumber: true, journalDate: true, referenceType: true, referenceId: true, description: true, branch: { select: { name: true } } } } },
    orderBy: [{ journal: { journalDate: "asc" } }, { journal: { journalNumber: "asc" } }],
  })
}
