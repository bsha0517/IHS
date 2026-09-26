import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { StatusBadge } from "@/components/ui/status-badge"
import { Button } from "@/components/ui/button"
import { REGULATORY_STATUS_LABEL, type RegulatoryIntegration } from "@/lib/domains/commercial/regulatory"

/**
 * P5.6 Part 5/13: SaaS configuration surface only, not a certification
 * claim — never renders "certified"/"approved"/"compliant" anywhere. See
 * regulatory.ts's own doc comment for exactly what each status does and
 * does not mean.
 */
export function RegulatoryCard({ integrations }: { integrations: RegulatoryIntegration[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Regulatory</CardTitle>
        <CardDescription>
          SaaS configuration status only — not a compliance or certification claim.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {integrations.map((integration) => (
          <div key={integration.code} className="grid gap-1 rounded-md border border-border p-3 text-sm sm:flex sm:items-center sm:justify-between sm:gap-4">
            <div>
              <div className="font-medium">{integration.label}</div>
              {integration.environment && <div className="text-xs text-muted-foreground">Environment: {integration.environment}</div>}
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge status={integration.status} label={REGULATORY_STATUS_LABEL[integration.status]} />
              {integration.configureHref && (
                <Button asChild size="sm" variant="outline">
                  <Link href={integration.configureHref}>Configure</Link>
                </Button>
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
