import { listPlans } from "@/lib/domains/commercial/plans"
import { PageHeader } from "@/components/ui/page-header"
import { Card, CardContent } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { ProvisionForm } from "@/app/platform/provision/provision-form"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import { PlatformPageShell } from "@/components/layout/platform-page-shell"

export default async function PlatformProvisionPage() {
  // P5.7 Part 5/31: an inactive plan is retained for historical subscriptions
  // (plans.ts never hard-deletes one) but must not be offered for new
  // provisioning.
  const plans = (await listPlans()).filter((p) => p.active)

  return (
    <PlatformPageShell>
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Provision Clinic"
        module="platform"
        description="Organization → commercial profile → plan/subscription → initial branch → initial administrator → module selection, as one atomic operation."
      />

      {plans.length === 0 ? (
        <EmptyState
          title="No commercial plans exist yet"
          description="Create at least one plan before provisioning a clinic."
          action={
            <Button asChild size="sm">
              <Link href="/platform/plans">Create a plan</Link>
            </Button>
          }
        />
      ) : (
        <Card>
          <CardContent className="pt-6">
            <ProvisionForm plans={plans.map((p) => ({ id: p.id, code: p.code, name: p.name, defaultModuleKeys: p.defaultModuleKeys }))} />
          </CardContent>
        </Card>
      )}
    </div>
    </PlatformPageShell>
  )
}
