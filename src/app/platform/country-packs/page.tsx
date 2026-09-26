import { PageHeader } from "@/components/ui/page-header"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { PlatformPageShell } from "@/components/layout/platform-page-shell"
import { ALL_COUNTRY_PACK_CODES, COUNTRY_PACKS, REGULATORY_SURFACE_STATIC_STATUS, REGULATORY_LABELS } from "@/lib/domains/commercial/country-packs-shared"

/**
 * P5.7 Part 14/18: a deliberately small, read-only reference — three
 * country definitions, not a regulatory configuration engine. Per-
 * organization regulatory status (whether THIS clinic has actually enabled
 * ZATCA) lives on the organization detail page's own RegulatoryCard
 * (P5.6); this page shows the country-level defaults/recommendations that
 * feed the provisioning wizard, never a live per-tenant state.
 */
export default function CountryPacksPage() {
  return (
    <PlatformPageShell>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Country Packs"
          module="platform"
          description="Recommended defaults per country — currency, timezone, and which regulatory surfaces are relevant. Not a compliance or certification claim."
        />

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {ALL_COUNTRY_PACK_CODES.map((code) => {
            const pack = COUNTRY_PACKS[code]
            return (
              <Card key={code}>
                <CardHeader>
                  <CardTitle className="text-base">
                    {pack.countryName} ({pack.code})
                  </CardTitle>
                  <CardDescription>Recommended commercial defaults</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Currency</span>
                    <span className="font-medium">{pack.currency}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Default timezone</span>
                    <span className="font-medium">{pack.defaultTimezone}</span>
                  </div>
                  <div className="grid gap-1.5">
                    <span className="text-muted-foreground">Regulatory surface(s)</span>
                    {pack.regulatorySurfaces.length === 0 ? (
                      <span className="text-xs text-muted-foreground">None defined</span>
                    ) : (
                      <ul className="grid gap-1">
                        {pack.regulatorySurfaces.map((surfaceCode) => (
                          <li key={surfaceCode} className="rounded-md border border-border p-2">
                            <div className="font-medium">{REGULATORY_LABELS[surfaceCode]}</div>
                            <div className="text-xs text-muted-foreground">{REGULATORY_SURFACE_STATIC_STATUS[surfaceCode]}</div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </div>
    </PlatformPageShell>
  )
}
