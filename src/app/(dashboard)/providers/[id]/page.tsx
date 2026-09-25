import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { getProvider } from "@/lib/domains/providers/service"
import { listBranches } from "@/lib/domains/identity/org-structure"
import { listEmployeeDirectory } from "@/lib/domains/hr/employees"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { DetailHeader } from "@/components/ui/page-header"
import { formatDate, formatDateTime } from "@/lib/utils/dates"
import {
  AddScheduleDialog,
  AddLeaveBlockDialog,
  DeleteScheduleButton,
  DeleteLeaveBlockButton,
  DAY_NAMES,
} from "@/app/(dashboard)/providers/[id]/schedule-dialogs"
import { LinkEmployeeDialog } from "@/app/(dashboard)/providers/[id]/link-employee-dialog"

export default async function ProviderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession()
  if (!session || !can(session, "provider.view")) redirect("/dashboard")

  const { id } = await params
  const [provider, branches, employees] = await Promise.all([getProvider(session, id), listBranches(session), listEmployeeDirectory(session)])
  const canManage = can(session, "provider.manage")

  return (
    <div className="flex flex-col gap-6">
      <DetailHeader
        module="clinical"
        title={`${provider.firstName} ${provider.lastName}`}
        meta={
          <span className="capitalize">
            {provider.providerType} {provider.specialty ? `· ${provider.specialty}` : ""}
          </span>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Details</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1.5 text-sm">
            <Row label="Qualification" value={provider.qualification} />
            <Row label="License" value={provider.licenseNumber} />
            <Row label="License authority" value={provider.licenseAuthority} />
            <Row label="License expiry" value={provider.licenseExpiryDate ? formatDate(provider.licenseExpiryDate) : null} />
            <Row label="Consultation fee" value={Number(provider.consultationFee).toFixed(2)} />
            <Row label="Default duration" value={`${provider.defaultAppointmentDurationMinutes} min`} />
            <Row label="Branches" value={provider.branches.map((b) => b.branch.name).join(", ")} />
            <Row label="Departments" value={provider.departments.map((d) => d.department.name).join(", ")} />
            <Row label="Eligible services" value={provider.services.map((s) => s.service.name).join(", ")} />
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Linked employee</span>
              <div className="flex items-center gap-1">
                <span>{provider.employee ? `${provider.employee.firstName} ${provider.employee.lastName}` : "—"}</span>
                {canManage && <LinkEmployeeDialog providerId={provider.id} currentEmployeeId={provider.employeeId} employees={employees} />}
              </div>
            </div>
            {/* P3.12 §15: this is what actually drives the Doctor dashboard
                and result notifications (getProviderForUser) — set only at
                creation (new-provider-dialog.tsx), shown here so Admin can
                at least see whether it's wired without guessing. */}
            <Row label="Linked login" value={provider.user ? `${provider.user.email} (${provider.user.status})` : "Not linked"} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Working hours</CardTitle>
            {canManage && <AddScheduleDialog providerId={provider.id} branches={branches} />}
          </CardHeader>
          <CardContent className="grid gap-2">
            {provider.schedules.length === 0 && <p className="text-sm text-muted-foreground">No working hours configured.</p>}
            {provider.schedules.map((s) => (
              <div key={s.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                <span>
                  {DAY_NAMES[s.dayOfWeek]}, {s.startTime}–{s.endTime}
                </span>
                {canManage && <DeleteScheduleButton providerId={provider.id} scheduleId={s.id} />}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="sm:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base">Leave &amp; time off</CardTitle>
              <p className="text-xs text-muted-foreground">Approved leave automatically blocks appointment booking.</p>
            </div>
            {canManage && <AddLeaveBlockDialog providerId={provider.id} />}
          </CardHeader>
          <CardContent className="grid gap-2">
            {provider.leaveBlocks.length === 0 && <p className="text-sm text-muted-foreground">No leave recorded.</p>}
            {provider.leaveBlocks.map((block) => {
              const isPast = block.endAt < new Date()
              return (
                <div key={block.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                  <div>
                    <span>
                      {formatDateTime(block.startAt)} → {formatDateTime(block.endAt)}
                    </span>
                    {block.reason && <span className="text-muted-foreground"> — {block.reason}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    {isPast && <Badge variant="secondary">Past</Badge>}
                    {canManage && <DeleteLeaveBlockButton providerId={provider.id} blockId={block.id} />}
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value || "—"}</span>
    </div>
  )
}
