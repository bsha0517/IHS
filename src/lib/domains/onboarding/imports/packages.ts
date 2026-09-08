import "server-only"
import { db } from "@/lib/db"
import { requiredString, requiredNumber, optionalNumber } from "@/lib/platform/import/parsers"
import type { ImporterDefinition, RowIssue } from "@/lib/platform/import/types"

/**
 * P4.9.2 §10 — Package/Treatment Plan master data. Mapped against `Package`
 * + `PackageService` (prisma/schema.prisma) — one CSV row is one package
 * plus its included services in one column, the same "codes;separated"
 * convention Providers'/Lab Panels' own multi-reference columns already
 * use. Every referenced service code must resolve (§10: "no silent
 * dropping of package items") — an unresolved service code fails the WHOLE
 * row. Never creates a `PatientPackage` purchase (§10).
 */
export type PackageRow = {
  code: string
  name: string
  price: number
  validityDays: number | null
  items: { serviceId: string; sessionsAllocated: number }[]
}

// One item is "serviceCode:sessions" — e.g. "PHYSIO01:10". Kept inline
// (not a second CSV column per item) so a package with several included
// services still fits one row, matching branchCodes/testCodes' own
// semicolon-list convention while still carrying the per-item quantity
// PackageService.sessionsAllocated requires.
function parseItem(raw: string): { serviceCode: string; sessions: number } | null {
  const [codePart, sessionsPart] = raw.split(":").map((s) => s.trim())
  if (!codePart || !sessionsPart) return null
  const sessions = Number(sessionsPart)
  if (!Number.isInteger(sessions) || sessions < 1) return null
  return { serviceCode: codePart, sessions }
}

export function createPackagesImporter(serviceIdByCode: Map<string, string>): ImporterDefinition<PackageRow> {
  return {
    type: "packages",
    group: "Commercial",
    templateVersion: "packages-v1",
    label: "Packages",
    requiredHeaders: ["code", "name", "price", "items"],
    optionalHeaders: ["validityDays"],
    helpText: [
      "code must be unique within your organization.",
      'items: one or more "serviceCode:sessions" pairs separated by ";" — e.g. "PHYSIO01:10;CONSULT01:1". Import Services first.',
      "validityDays (optional): whole number of days the package remains usable after purchase.",
      "This import creates the package definition only — it never creates a patient's purchased package.",
    ],
    async parseRow(raw) {
      const issues: RowIssue[] = []
      const push = (i: RowIssue | null) => i && issues.push(i)

      const code = requiredString(raw.code, "code", 30)
      push(code.error)
      const name = requiredString(raw.name, "name", 200)
      push(name.error)
      const price = requiredNumber(raw.price, "price", { min: 0, max: 9999999 })
      push(price.error)
      const validityDays = optionalNumber(raw.validityDays, "validityDays", { min: 1, max: 3650, integer: true })
      push(validityDays.error)

      const itemsRaw = raw.items?.trim()
      const items: { serviceId: string; sessionsAllocated: number }[] = []
      if (!itemsRaw) {
        issues.push({ field: "items", code: "REQUIRED_FIELD", message: "items is required (at least one serviceCode:sessions pair)." })
      } else {
        for (const part of itemsRaw.split(";").map((p) => p.trim()).filter(Boolean)) {
          const parsed = parseItem(part)
          if (!parsed) {
            issues.push({ field: "items", code: "INVALID_REFERENCE", message: `items: "${part}" is not a valid "serviceCode:sessions" pair (sessions must be a whole number of at least 1).` })
            continue
          }
          const serviceId = serviceIdByCode.get(parsed.serviceCode.toLowerCase())
          if (!serviceId) {
            issues.push({ field: "items", code: "UNKNOWN_REFERENCE", message: `items: service code "${parsed.serviceCode}" does not match any existing service — import Services first.` })
            continue
          }
          items.push({ serviceId, sessionsAllocated: parsed.sessions })
        }
      }

      if (issues.length > 0) return { normalized: null, issues }
      return { normalized: { code: code.value!, name: name.value!, price: price.value!, validityDays: validityDays.value, items }, issues: [] }
    },

    async detectDuplicates(rows, ctx) {
      const candidates = rows.filter((r) => r.normalized)
      if (candidates.length === 0) return
      const codes = [...new Set(candidates.map((r) => r.normalized!.code))]
      const existing = await db.package.findMany({ where: { organizationId: ctx.organizationId, code: { in: codes } }, select: { code: true } })
      const existingCodes = new Set(existing.map((e) => e.code.toLowerCase()))
      const seen = new Set<string>()
      for (const row of candidates) {
        const code = row.normalized!.code.toLowerCase()
        if (existingCodes.has(code)) {
          row.duplicate = true
          row.duplicateReason = `A package with code "${row.normalized!.code}" already exists.`
        } else if (seen.has(code)) {
          row.duplicate = true
          row.duplicateReason = "Duplicate code within this same file."
        }
        seen.add(code)
      }
    },

    async commitBatch(tx, rows, ctx) {
      let imported = 0
      for (const row of rows) {
        const n = row.normalized!
        const pkg = await tx.package.create({
          data: { organizationId: ctx.organizationId, code: n.code, name: n.name, price: n.price, validityDays: n.validityDays },
        })
        await tx.packageService.createMany({ data: n.items.map((i) => ({ packageId: pkg.id, serviceId: i.serviceId, sessionsAllocated: i.sessionsAllocated })) })
        imported++
      }
      return { imported, skipped: 0 }
    },
  }
}
