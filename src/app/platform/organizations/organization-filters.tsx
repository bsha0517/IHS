"use client"

import { useState } from "react"
import { useRouter, usePathname } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { FilterBar, FilterField } from "@/components/ui/filter-bar"
import type { $Enums } from "@/generated/prisma/client"

const ALL = "__all__"

const SUBSCRIPTION_STATUSES: $Enums.SubscriptionStatus[] = ["trial", "active", "past_due", "suspended", "cancelled", "expired"]
const ONBOARDING_STATUSES: $Enums.CommercialOnboardingStatus[] = ["not_started", "in_progress", "ready_for_uat", "uat", "ready_for_go_live", "live"]
const LIFECYCLE_STATUSES: $Enums.CommercialLifecycle[] = ["onboarding", "live", "closed"]

/** P5.6 Part 2: practical filters on the existing (already-paginated) organizations list — no new analytics, just WHERE-clause narrowing already supported by listOrganizationsForPlatform. */
export function OrganizationFilters({
  countries,
  sp,
}: {
  countries: string[]
  sp: Record<string, string | undefined>
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [q, setQ] = useState(sp.q ?? "")
  const [country, setCountry] = useState(sp.country ?? ALL)
  const [subscriptionStatus, setSubscriptionStatus] = useState(sp.subscriptionStatus ?? ALL)
  const [onboardingStatus, setOnboardingStatus] = useState(sp.onboardingStatus ?? ALL)
  const [goLive, setGoLive] = useState(sp.goLive ?? ALL)

  function apply() {
    const params = new URLSearchParams()
    if (q) params.set("q", q)
    if (country !== ALL) params.set("country", country)
    if (subscriptionStatus !== ALL) params.set("subscriptionStatus", subscriptionStatus)
    if (onboardingStatus !== ALL) params.set("onboardingStatus", onboardingStatus)
    if (goLive !== ALL) params.set("goLive", goLive)
    router.push(`${pathname}?${params.toString()}`)
  }

  function clear() {
    setQ("")
    setCountry(ALL)
    setSubscriptionStatus(ALL)
    setOnboardingStatus(ALL)
    setGoLive(ALL)
    router.push(pathname)
  }

  const hasFilters = Boolean(sp.q || sp.country || sp.subscriptionStatus || sp.onboardingStatus || sp.goLive)

  return (
    <FilterBar onSubmit={(e) => e.preventDefault()}>
      <FilterField label="Search" htmlFor="q" className="min-w-[200px]">
        <Input id="q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, customer code, contact..." />
      </FilterField>
      <FilterField label="Country">
        <Select value={country} onValueChange={setCountry}>
          <SelectTrigger className="w-[130px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All countries</SelectItem>
            {countries.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterField>
      <FilterField label="Subscription">
        <Select value={subscriptionStatus} onValueChange={setSubscriptionStatus}>
          <SelectTrigger className="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All subscriptions</SelectItem>
            {SUBSCRIPTION_STATUSES.map((s) => (
              <SelectItem key={s} value={s} className="capitalize">
                {s.replace(/_/g, " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterField>
      <FilterField label="Onboarding">
        <Select value={onboardingStatus} onValueChange={setOnboardingStatus}>
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All onboarding</SelectItem>
            {ONBOARDING_STATUSES.map((s) => (
              <SelectItem key={s} value={s} className="capitalize">
                {s.replace(/_/g, " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterField>
      <FilterField label="Go-live">
        <Select value={goLive} onValueChange={setGoLive}>
          <SelectTrigger className="w-[130px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All</SelectItem>
            {LIFECYCLE_STATUSES.map((s) => (
              <SelectItem key={s} value={s} className="capitalize">
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterField>
      <Button type="button" size="sm" onClick={apply}>
        Filter
      </Button>
      {hasFilters && (
        <Button type="button" size="sm" variant="ghost" onClick={clear}>
          Clear
        </Button>
      )}
    </FilterBar>
  )
}
