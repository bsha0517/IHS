import "server-only"
import { db } from "@/lib/db"
import { requiredString, optionalString, requiredEnum } from "@/lib/platform/import/parsers"
import type { ImporterDefinition, RowIssue } from "@/lib/platform/import/types"

/**
 * P4.9.2 §26/§27 — HIGH RISK: Chart of Accounts master data. Mapped
 * against `ChartOfAccount` (prisma/schema.prisma) — no `description` or
 * `normalBalance` field exists on this model (normal balance is implied by
 * `type`), so neither is imported.
 *
 * Parent resolution is deliberately narrow: `parentAccountCode` must match
 * an account that ALREADY EXISTS in the database before this import runs —
 * never another row in the same file. This avoids needing same-transaction
 * forward-reference resolution (a child row could otherwise reference a
 * parent row appearing later, or in the same 200-row commit batch, before
 * that parent has actually been created) and, as a side effect, makes a
 * genuinely circular hierarchy impossible to construct through this
 * importer at all — a newly-imported row can never become an ancestor of
 * anything that already exists. To import a multi-level hierarchy: import
 * root accounts first (no parentAccountCode), then import child accounts
 * referencing them by code in a separate, later file — see
 * docs/CLINIC_ONBOARDING.md's dependency order.
 *
 * §28 — this importer NEVER creates or infers an `AccountMapping`
 * (PostingIntent). "Accounts Receivable" as an account name does not
 * become the AR posting mapping just because it's named that — the
 * administrator maps it explicitly afterward (Readiness Review already
 * surfaces missing required mappings — see readiness.ts).
 */
const ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "expense"] as const

export type ChartOfAccountRow = {
  code: string
  name: string
  type: (typeof ACCOUNT_TYPES)[number]
  parentAccountCode: string | null
}

export function createChartOfAccountsImporter(): ImporterDefinition<ChartOfAccountRow> {
  return {
    type: "chart_of_accounts",
    group: "Finance",
    riskLevel: "high",
    confirmationText: "I understand this import creates real Chart of Accounts records used for financial posting, and that imported accounts still require Account Mapping configuration before they're used for automated posting.",
    templateVersion: "chart-of-accounts-v1",
    label: "Chart of Accounts",
    requiredHeaders: ["code", "name", "type"],
    optionalHeaders: ["parentAccountCode"],
    helpText: [
      "code must be unique within your organization.",
      `type: ${ACCOUNT_TYPES.join(", ")}.`,
      "parentAccountCode (optional) must match an account that ALREADY EXISTS in your organization — to import a multi-level hierarchy, import parent (root) accounts first, then child accounts referencing them in a separate, later import.",
      "Importing accounts does not configure Account Mapping (PostingIntent) — you still need to map required intents (Accounts Receivable, Revenue, etc.) afterward on the Accounting page; Readiness Review will show what's still missing.",
    ],
    async parseRow(raw) {
      const issues: RowIssue[] = []
      const push = (i: RowIssue | null) => i && issues.push(i)

      const code = requiredString(raw.code, "code", 20)
      push(code.error)
      const name = requiredString(raw.name, "name", 200)
      push(name.error)
      const type = requiredEnum(raw.type, "type", ACCOUNT_TYPES)
      push(type.error)
      const parentAccountCode = optionalString(raw.parentAccountCode, "parentAccountCode", 20)
      push(parentAccountCode.error)

      if (code.value && parentAccountCode.value && code.value.toLowerCase() === parentAccountCode.value.toLowerCase()) {
        issues.push({ field: "parentAccountCode", code: "BUSINESS_RULE", message: "An account cannot be its own parent." })
      }

      if (issues.length > 0) return { normalized: null, issues }
      return { normalized: { code: code.value!, name: name.value!, type: type.value!, parentAccountCode: parentAccountCode.value }, issues: [] }
    },

    async detectDuplicates(rows, ctx) {
      const candidates = rows.filter((r) => r.normalized)
      if (candidates.length === 0) return

      const codes = [...new Set(candidates.map((r) => r.normalized!.code))]
      const parentCodesReferenced = [...new Set(candidates.map((r) => r.normalized!.parentAccountCode).filter((c): c is string => !!c))]
      const allCodesToLoad = [...new Set([...codes, ...parentCodesReferenced])]

      const existing = await db.chartOfAccount.findMany({
        where: { organizationId: ctx.organizationId, code: { in: allCodesToLoad } },
        select: { id: true, code: true, parentAccountId: true },
      })
      const existingByCode = new Map(existing.map((e) => [e.code.toLowerCase(), e]))
      const existingById = new Map(existing.map((e) => [e.id, e]))

      const seenInFile = new Set<string>()
      for (const row of candidates) {
        const n = row.normalized!
        const code = n.code.toLowerCase()

        if (existingByCode.has(code)) {
          row.duplicate = true
          row.duplicateReason = `An account with code "${n.code}" already exists.`
          seenInFile.add(code)
          continue
        }
        if (seenInFile.has(code)) {
          row.duplicate = true
          row.duplicateReason = "Duplicate code within this same file."
          continue
        }
        seenInFile.add(code)

        if (n.parentAccountCode) {
          const parent = existingByCode.get(n.parentAccountCode.toLowerCase())
          if (!parent) {
            row.issues.push({
              field: "parentAccountCode",
              code: "UNKNOWN_REFERENCE",
              message: `parentAccountCode "${n.parentAccountCode}" does not match any existing account in this organization — import it first, in a separate file.`,
            })
            continue
          }
          // Defense-in-depth circular check — walk the resolved parent's own
          // ancestor chain; a code this import is about to create cannot
          // legitimately already appear there (nothing here can create it
          // before now), so a match means the EXISTING data already has a
          // cycle, which this import must refuse to extend rather than
          // silently accept.
          let cursor = parent
          for (let hops = 0; hops < 50 && cursor.parentAccountId; hops++) {
            const next = existingById.get(cursor.parentAccountId)
            if (!next) break
            if (next.code.toLowerCase() === code) {
              row.issues.push({ field: "parentAccountCode", code: "BUSINESS_RULE", message: `parentAccountCode "${n.parentAccountCode}" would create a circular account hierarchy.` })
              break
            }
            cursor = next
          }
        }
      }
    },

    async commitBatch(tx, rows, ctx) {
      // Parent ids are re-resolved here (not carried from detectDuplicates)
      // since a batch runs in its own transaction, sequentially after any
      // earlier batch's accounts have already committed — the same
      // find-then-create pattern every multi-batch-safe importer in this
      // codebase uses.
      const parentCodes = [...new Set(rows.map((r) => r.normalized!.parentAccountCode).filter((c): c is string => !!c))]
      const parents = parentCodes.length > 0
        ? await tx.chartOfAccount.findMany({ where: { organizationId: ctx.organizationId, code: { in: parentCodes } }, select: { id: true, code: true } })
        : []
      const parentIdByCode = new Map(parents.map((p) => [p.code.toLowerCase(), p.id]))

      const data = rows.map((r) => ({
        organizationId: ctx.organizationId,
        code: r.normalized!.code,
        name: r.normalized!.name,
        type: r.normalized!.type,
        parentAccountId: r.normalized!.parentAccountCode ? (parentIdByCode.get(r.normalized!.parentAccountCode.toLowerCase()) ?? null) : null,
      }))
      const result = await tx.chartOfAccount.createMany({ data })
      return { imported: result.count, skipped: 0 }
    },

    // P4.9.2 §41 — root vs child account counts.
    computeDomainSummary(rows) {
      const committable = rows.filter((r) => r.issues.length === 0 && !r.duplicate && r.normalized)
      const roots = committable.filter((r) => !r.normalized!.parentAccountCode).length
      const children = committable.length - roots
      return [
        { label: "Accounts to create", value: String(committable.length) },
        { label: "Root accounts", value: String(roots) },
        { label: "Child accounts", value: String(children) },
      ]
    },
  }
}
