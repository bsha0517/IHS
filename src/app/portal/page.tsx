import { redirect } from "next/navigation"
import { getCurrentPortalSession } from "@/lib/auth/portal-session"
import {
  getPortalProfile,
  listPortalAppointments,
  listPortalPrescriptions,
  listPortalLabResults,
  listPortalImagingResults,
  listPortalInvoices,
  listPortalPayments,
  listPortalPackages,
} from "@/lib/domains/portal/data"
import { isPortalClinicalReleaseEnabled } from "@/lib/platform/settings"
import { calculateAge, formatDate, formatDateTime } from "@/lib/utils/dates"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { ProfileForm } from "@/app/portal/profile-form"
import { portalLogoutAction } from "@/app/portal/actions"

export default async function PortalDashboardPage() {
  const portalSession = await getCurrentPortalSession()
  if (!portalSession) redirect("/portal/login")

  const [profile, appointments, prescriptions, labResults, imagingResults, invoices, payments, packages, clinicalReleased] = await Promise.all([
    getPortalProfile(portalSession),
    listPortalAppointments(portalSession),
    listPortalPrescriptions(portalSession),
    listPortalLabResults(portalSession),
    listPortalImagingResults(portalSession),
    listPortalInvoices(portalSession),
    listPortalPayments(portalSession),
    listPortalPackages(portalSession),
    isPortalClinicalReleaseEnabled(portalSession.patient.organizationId),
  ])

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {profile.firstName} {profile.lastName}
          </h1>
          <p className="text-sm text-muted-foreground">
            {profile.mrn} · {calculateAge(profile.dob)}y
          </p>
        </div>
        <form action={portalLogoutAction}>
          <Button type="submit" size="sm" variant="outline">
            Sign out
          </Button>
        </form>
      </div>

      <Tabs defaultValue="appointments">
        <TabsList className="flex-wrap">
          <TabsTrigger value="appointments">Appointments</TabsTrigger>
          <TabsTrigger value="prescriptions">Prescriptions</TabsTrigger>
          <TabsTrigger value="results">Results</TabsTrigger>
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
          <TabsTrigger value="payments">Payments</TabsTrigger>
          <TabsTrigger value="packages">Packages</TabsTrigger>
          <TabsTrigger value="profile">Profile</TabsTrigger>
        </TabsList>

        <TabsContent value="appointments">
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>Service</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {appointments.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground">
                        No appointments.
                      </TableCell>
                    </TableRow>
                  )}
                  {appointments.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell>{formatDateTime(a.startTime)}</TableCell>
                      <TableCell>
                        {a.provider.firstName} {a.provider.lastName}
                      </TableCell>
                      <TableCell>{a.service?.name ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{a.status.replace("_", " ")}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="prescriptions">
          {!clinicalReleased ? (
            <p className="p-6 text-center text-sm text-muted-foreground">Prescriptions are not yet available online — please contact the clinic.</p>
          ) : (
            <Card>
              <CardContent className="pt-6">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Provider</TableHead>
                      <TableHead>Items</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {prescriptions.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={3} className="text-center text-muted-foreground">
                          No active prescriptions.
                        </TableCell>
                      </TableRow>
                    )}
                    {prescriptions.map((rx) => (
                      <TableRow key={rx.id}>
                        <TableCell>{formatDate(rx.issuedAt)}</TableCell>
                        <TableCell>
                          {rx.provider.firstName} {rx.provider.lastName}
                        </TableCell>
                        <TableCell>{rx.items.map((i) => i.medicationName).join(", ")}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="results" className="grid gap-4">
          {!clinicalReleased ? (
            <p className="p-6 text-center text-sm text-muted-foreground">Results are not yet available online — please contact the clinic.</p>
          ) : (
            <>
              <Card>
                <CardContent className="pt-6">
                  <p className="mb-3 text-sm font-medium">Lab results</p>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Verified</TableHead>
                        <TableHead>Test</TableHead>
                        <TableHead>Result</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {labResults.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={3} className="text-center text-muted-foreground">
                            No lab results.
                          </TableCell>
                        </TableRow>
                      )}
                      {labResults.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell>{r.verifiedAt ? formatDate(r.verifiedAt) : "—"}</TableCell>
                          <TableCell>{r.labTest.name}</TableCell>
                          <TableCell>{r.numericValue != null ? `${r.numericValue} ${r.unit ?? ""}` : r.textValue ?? "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <p className="mb-3 text-sm font-medium">Imaging results</p>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Verified</TableHead>
                        <TableHead>Study</TableHead>
                        <TableHead>Impression</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {imagingResults.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={3} className="text-center text-muted-foreground">
                            No imaging results.
                          </TableCell>
                        </TableRow>
                      )}
                      {imagingResults.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell>{r.verifiedAt ? formatDate(r.verifiedAt) : "—"}</TableCell>
                          <TableCell>{r.imagingService.name}</TableCell>
                          <TableCell>{r.impression ?? "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        <TabsContent value="invoices">
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground">
                        No invoices.
                      </TableCell>
                    </TableRow>
                  )}
                  {invoices.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell>{inv.invoiceNumber}</TableCell>
                      <TableCell>{formatDate(inv.issuedAt)}</TableCell>
                      <TableCell className="text-right">{Number(inv.totalAmount).toFixed(2)}</TableCell>
                      <TableCell className="text-right">{(Number(inv.totalAmount) - Number(inv.paidAmount)).toFixed(2)}</TableCell>
                      <TableCell>
                        <Badge variant={inv.status === "paid" ? "default" : "outline"}>{inv.status.replace("_", " ")}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="payments">
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Receipt</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground">
                        No payments.
                      </TableCell>
                    </TableRow>
                  )}
                  {payments.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>{p.receiptNumber}</TableCell>
                      <TableCell className="capitalize">{p.method}</TableCell>
                      <TableCell className="text-right">{Number(p.amount).toFixed(2)}</TableCell>
                      <TableCell>{formatDate(p.receivedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="packages">
          <Card>
            <CardContent className="grid gap-3 pt-6">
              {packages.length === 0 && <p className="text-sm text-muted-foreground">No packages.</p>}
              {packages.map((pp) => (
                <div key={pp.id} className="rounded-md border border-border p-3 text-sm">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="font-medium">{pp.package.name}</p>
                    <Badge variant={pp.status === "active" ? "default" : "secondary"}>{pp.status}</Badge>
                  </div>
                  <div className="grid gap-1">
                    {pp.remaining.map((r) => (
                      <p key={r.packageServiceId} className="text-muted-foreground">
                        {r.serviceName}: {r.allocated - r.used} of {r.allocated} remaining
                      </p>
                    ))}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="profile">
          <Card>
            <CardContent className="pt-6">
              <ProfileForm mobile={profile.mobile} email={profile.email} addressLine={profile.addressLine} city={profile.city} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
