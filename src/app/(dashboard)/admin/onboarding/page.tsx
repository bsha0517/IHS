import Link from "next/link"
import { redirect } from "next/navigation"
import { CheckCircle2, Circle, AlertTriangle, MinusCircle } from "lucide-react"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { getOnboardingStatus, type ReadinessState } from "@/lib/domains/onboarding/readiness"
import { getImporterCatalog } from "@/lib/domains/onboarding/imports/registry"
import { db } from "@/lib/db"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { StatusBadge } from "@/components/ui/status-badge"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatDateTime } from "@/lib/utils/dates"
import { PageHeader } from "@/components/ui/page-header"
import { ImportDialog } from "@/app/(dashboard)/admin/onboarding/import-dialog"
import { CancelImportButton } from "@/app/(dashboard)/admin/onboarding/cancel-button"
import { IMPORTER_GROUPS } from "@/lib/platform/import/types"

const STATE_ICON: Record<ReadinessState, typeof CheckCircle2> = {
  ready: CheckCircle2,
  in_progress: Circle,
  not_started: Circle,
  optional: MinusCircle,
  attention_required: AlertTriangle,
}
const STATE_LABEL: Record<ReadinessState, string> = {
  ready: "Ready",
  in_progress: "In Progress",
  not_started: "Not Started",
  optional: "Optional",
  attention_required: "Attention Required",
}

/**
 * P4.6 §7-9 — the onboarding workspace: a setup checklist/workspace that
 * deep-links to existing configuration screens (§7's own explicit "do not
 * duplicate existing CRUD UI" instruction) plus the reusable CSV import
 * flow. Operational readiness language only (§60/§78) — never "compliant"
 * or "certified."
 */
export default async function OnboardingPage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "data_import.manage")) redirect("/dashboard")

  const [status, importers, recentJobs] = await Promise.all([
    getOnboardingStatus(session),
    getImporterCatalog(session),
    db.importJob.findMany({
      where: { organizationId: session.user.organizationId },
      orderBy: { startedAt: "desc" },
      take: 20,
      include: { startedByUser: { select: { firstName: true, lastName: true } } },
    }),
  ])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Clinic Onboarding"
        description={
          <>
            Operational setup checklist and data import workspace.{" "}
            {status.operationallyReady ? (
              <span className="font-medium text-foreground">Operational setup ready.</span>
            ) : (
              <span>Some required setup is still incomplete — see below.</span>
            )}
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Readiness Review</CardTitle>
          <CardDescription>Derived live from your actual configuration — nothing here is a manual checkbox.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Area</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Detail</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {status.items.map((item) => {
                const Icon = STATE_ICON[item.status]
                return (
                  <TableRow key={item.label}>
                    <TableCell className="capitalize text-muted-foreground">{item.area}</TableCell>
                    <TableCell className="font-medium">{item.label}</TableCell>
                    <TableCell>
                      {/* P4.7A.1 §38 — the semantic status system, not a
                          bespoke variant map, while keeping the icon (never
                          color/tone alone for "attention required"). */}
                      <span className="inline-flex items-center gap-1.5">
                        <Icon className="size-3.5" />
                        <StatusBadge status={item.status} label={STATE_LABEL[item.status]} />
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{item.reason}</TableCell>
                    <TableCell>
                      <Link href={item.destination} className="text-sm text-primary hover:underline">
                        Configure
                      </Link>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Data Import</CardTitle>
          <CardDescription>
            Template → Upload → Dry Run → Review → Explicit Commit. Every import is validated before anything is written — no partial or silent import.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          {/* P4.9.2 §54 — grouped by logical section (not one flat grid of
              16+ cards), same order as IMPORTER_GROUPS. §55 — Opening
              Inventory/Payroll/Chart of Accounts/Users each carry
              riskLevel: "high" and render a distinct badge + require an
              explicit confirmation checkbox before Commit (see
              ImportDialog). */}
          {IMPORTER_GROUPS.map((group) => {
            const inGroup = importers.filter((imp) => imp.group === group)
            if (inGroup.length === 0) return null
            return (
              <div key={group} className="grid gap-3">
                <p className="text-sm font-medium text-muted-foreground">{group}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {inGroup.map((imp) => (
                    <div key={imp.type} className="flex items-center justify-between rounded-md border border-border p-3">
                      <div>
                        <p className="flex items-center gap-1.5 font-medium">
                          {imp.label}
                          {imp.riskLevel === "high" && (
                            <Badge variant="destructive" className="text-[10px]">
                              High risk
                            </Badge>
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground">{imp.templateVersion}</p>
                      </div>
                      <ImportDialog
                        type={imp.type}
                        label={imp.label}
                        helpText={imp.helpText}
                        templateUrl={`/api/onboarding/template/${imp.type}`}
                        confirmationText={imp.confirmationText}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Import History</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>File</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Rows (imported/skipped/invalid/duplicate)</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentJobs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    No imports yet.
                  </TableCell>
                </TableRow>
              )}
              {recentJobs.map((job) => (
                <TableRow key={job.id}>
                  <TableCell className="capitalize">{job.type.replace("_", " ")}</TableCell>
                  <TableCell className="max-w-40 truncate text-xs" title={job.fileName}>
                    {job.fileName}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={job.status} />
                  </TableCell>
                  <TableCell className="text-sm">
                    {job.startedByUser.firstName} {job.startedByUser.lastName}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDateTime(job.startedAt)}</TableCell>
                  <TableCell className="text-xs">
                    {job.importedRows}/{job.skippedRows}/{job.invalidRows}/{job.duplicateRows}
                  </TableCell>
                  <TableCell>
                    {(job.status === "uploaded" || job.status === "validated") && <CancelImportButton jobId={job.id} />}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
