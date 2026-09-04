import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listTemplates } from "@/lib/domains/communications/templates"
import { listMessageHistory } from "@/lib/domains/communications/service"
import { listUpcomingAppointmentsForReminder, listOutstandingInvoicesForReminder, listPatientsWithBirthdayToday } from "@/lib/domains/communications/hub"
import { formatDateTime, formatDate } from "@/lib/utils/dates"
import { Card, CardContent } from "@/components/ui/card"
import { PageHeader } from "@/components/ui/page-header"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { TemplateDialog } from "@/app/(dashboard)/communications/template-dialog"
import { SendReminderButton, SendPaymentReminderButton, SendBirthdayGreetingButton } from "@/app/(dashboard)/communications/send-buttons"
import { PaginationControls } from "@/components/domain/pagination-controls"

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  queued: "outline",
  sent: "default",
  failed: "destructive",
}

export default async function CommunicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>
}) {
  const session = await getCurrentSession()
  if (!session || !can(session, "communication.send")) redirect("/dashboard")

  const canManageTemplates = can(session, "communication.manage")
  const sp = await searchParams

  const [upcoming, outstanding, birthdays, templates, historyResult] = await Promise.all([
    listUpcomingAppointmentsForReminder(session),
    listOutstandingInvoicesForReminder(session),
    listPatientsWithBirthdayToday(session),
    listTemplates(session),
    listMessageHistory(session, { page: sp.page ? Number(sp.page) : undefined }),
  ])
  const { messages: history, total: historyTotal, page: historyPage, totalPages: historyTotalPages } = historyResult

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Communications" />

      <Tabs defaultValue={sp.page ? "history" : "reminders"}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="reminders">Appointment Reminders</TabsTrigger>
          <TabsTrigger value="payments">Payment Reminders</TabsTrigger>
          <TabsTrigger value="birthdays">Birthdays Today</TabsTrigger>
          <TabsTrigger value="templates">Templates</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="reminders" className="grid gap-4">
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Patient</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>When</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {upcoming.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground">
                        No appointments in the next 48 hours.
                      </TableCell>
                    </TableRow>
                  )}
                  {upcoming.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell>
                        {a.patient.firstName} {a.patient.lastName}
                      </TableCell>
                      <TableCell>
                        {a.provider.firstName} {a.provider.lastName}
                      </TableCell>
                      <TableCell>{formatDateTime(a.startTime)}</TableCell>
                      <TableCell>
                        <SendReminderButton
                          patientId={a.patientId}
                          patientName={`${a.patient.firstName} ${a.patient.lastName}`}
                          appointmentId={a.id}
                          providerName={`${a.provider.firstName} ${a.provider.lastName}`}
                          appointmentDate={a.startTime}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="payments" className="grid gap-4">
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Patient</TableHead>
                    <TableHead>Invoice</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {outstanding.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground">
                        No outstanding invoices.
                      </TableCell>
                    </TableRow>
                  )}
                  {outstanding.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell>
                        {inv.patient.firstName} {inv.patient.lastName}
                      </TableCell>
                      <TableCell>{inv.invoiceNumber}</TableCell>
                      <TableCell className="text-right">{(Number(inv.totalAmount) - Number(inv.paidAmount)).toFixed(2)}</TableCell>
                      <TableCell>
                        <SendPaymentReminderButton
                          patientId={inv.patientId}
                          patientName={`${inv.patient.firstName} ${inv.patient.lastName}`}
                          invoiceId={inv.id}
                          invoiceNumber={inv.invoiceNumber}
                          outstandingAmount={Number(inv.totalAmount) - Number(inv.paidAmount)}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="birthdays" className="grid gap-4">
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Patient</TableHead>
                    <TableHead>MRN</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {birthdays.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={3} className="text-center text-muted-foreground">
                        No patient birthdays today.
                      </TableCell>
                    </TableRow>
                  )}
                  {birthdays.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>
                        {p.firstName} {p.lastName}
                      </TableCell>
                      <TableCell>{p.mrn}</TableCell>
                      <TableCell>
                        <SendBirthdayGreetingButton patientId={p.id} patientName={`${p.firstName} ${p.lastName}`} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="templates" className="grid gap-4">
          <div className="flex justify-end">{canManageTemplates && <TemplateDialog />}</div>
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Key</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Channel</TableHead>
                    <TableHead>Body</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {templates.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell className="font-mono text-xs">{t.key}</TableCell>
                      <TableCell>{t.name}</TableCell>
                      <TableCell className="capitalize">{t.channel}</TableCell>
                      <TableCell className="max-w-md truncate text-muted-foreground">{t.body}</TableCell>
                      <TableCell>
                        {canManageTemplates && (
                          <TemplateDialog
                            existing={{ id: t.id, key: t.key, channel: t.channel, name: t.name, subject: t.subject, body: t.body }}
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

        <TabsContent value="history" className="grid gap-4">
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Sent</TableHead>
                    <TableHead>Patient</TableHead>
                    <TableHead>Channel</TableHead>
                    <TableHead>To</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground">
                        No messages sent yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {history.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell>{formatDate(m.createdAt)}</TableCell>
                      <TableCell>
                        {m.patient.firstName} {m.patient.lastName}
                      </TableCell>
                      <TableCell className="capitalize">{m.channel}</TableCell>
                      <TableCell>{m.recipientAddress || "—"}</TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[m.status] ?? "outline"}>{m.status}</Badge>
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-muted-foreground">{m.error ?? m.body}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <PaginationControls page={historyPage} totalPages={historyTotalPages} total={historyTotal} basePath="/communications" searchParams={sp} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
