import { NextResponse, type NextRequest } from "next/server"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { getImporter, isImportType } from "@/lib/domains/onboarding/imports/registry"
import { toCsv } from "@/lib/platform/import/csv"

/**
 * P4.6 §49 — downloadable, exact-header CSV templates, generated from the
 * importer's own `requiredHeaders`/`optionalHeaders` (never hand-maintained
 * separately, so a template can't drift from what the parser actually
 * accepts). Deliberately headers-only, no example row (§49's own "prefer
 * empty templates + separate help text if examples could accidentally be
 * imported" guidance) — the help text a real example row would otherwise
 * carry is instead returned as an HTML comment... no: as a genuine
 * trailing comment row is not standard CSV, so it's surfaced in the
 * onboarding UI directly instead (see page.tsx's own help-text panel).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ type: string }> }) {
  const session = await getCurrentSession()
  if (!session) return NextResponse.json({ error: { code: "unauthenticated", message: "Sign in required." } }, { status: 401 })
  if (!can(session, "data_import.manage")) {
    return NextResponse.json({ error: { code: "forbidden", message: "Missing permission to download import templates." } }, { status: 403 })
  }

  const { type } = await params
  if (!isImportType(type)) return NextResponse.json({ error: { code: "unknown_type", message: "Unknown import type." } }, { status: 404 })

  const importer = await getImporter(session, type)
  const headers = [...importer.requiredHeaders, ...importer.optionalHeaders]
  const csv = toCsv(headers, [])

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${importer.templateVersion}.csv"`,
    },
  })
}
