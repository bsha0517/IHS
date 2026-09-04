import { NextResponse, type NextRequest } from "next/server"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { db } from "@/lib/db"
import { toCsv } from "@/lib/platform/import/csv"

/** P4.6 §44 — the dry-run/commit validation report, downloadable as CSV: row, field, severity, code, message. Never echoes source row field values (§44's own "do not echo every patient data field" instruction) — this table only ever holds row/field/code/message, per ImportJobError's own narrow schema. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const session = await getCurrentSession()
  if (!session) return NextResponse.json({ error: { code: "unauthenticated", message: "Sign in required." } }, { status: 401 })
  if (!can(session, "data_import.manage")) {
    return NextResponse.json({ error: { code: "forbidden", message: "Missing permission to view import errors." } }, { status: 403 })
  }

  const { jobId } = await params
  const job = await db.importJob.findFirst({ where: { id: jobId, organizationId: session.user.organizationId } })
  if (!job) return NextResponse.json({ error: { code: "not_found", message: "Import job not found." } }, { status: 404 })

  const errors = await db.importJobError.findMany({ where: { jobId }, orderBy: [{ rowNumber: "asc" }] })
  const csv = toCsv(
    ["row", "field", "severity", "code", "message"],
    errors.map((e) => [e.rowNumber, e.field ?? "", "error", e.errorCode, e.message])
  )

  return new NextResponse(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${job.type}-errors-${job.id.slice(0, 8)}.csv"` },
  })
}
