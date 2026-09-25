# P5.4 — Commercial Handover

An operational handover checklist and workflow for moving a new clinic from Sales/Commercial through
Implementation, Support/Operations, and finally the clinic itself. Not a CRM — this document
describes the process and the information it requires, all of which already has a real home in the
existing product (the organization's commercial profile, subscription, and onboarding checklist).

## 1. Handover Chain

```
Sales / Commercial
       ↓  (fills in commercial terms; requests provisioning)
Implementation
       ↓  (provisions, configures, runs UAT, tracks go-live readiness)
Support / Operations
       ↓  (owns the clinic post-launch: incidents, tickets, ongoing changes)
Clinic
```

Each stage is a real, distinct actor in the system today: a platform operator provisions and
implements (`/platform/organizations/[id]`, `/platform/organizations/[id]/onboarding`,
`/platform/organizations/[id]/uat`); the same or a different platform operator owns go-live approval
and, afterward, support (`/platform/tickets`); the clinic's own Super Admin and staff operate day to
day and raise tickets from `/support`.

## 2. Information Required at Each Handover

### Sales → Implementation

| Field | Where it's recorded |
|---|---|
| Organization display/legal name | `/platform/provision` → `Organization` |
| Plan | `/platform/provision` → `CommercialPlan` |
| Subscription status/dates/limits | `/platform/provision` → `OrganizationSubscription` |
| Entitlements (modules purchased) | `/platform/provision`'s module selection → `seedModuleEntitlementsFromPlan` |
| Primary clinic contact | Commercial profile — `primaryContactName`/`primaryContactEmail`/`primaryContactPhone` |
| Billing contact | Commercial profile — `billingContactName`/`billingContactEmail` |
| Country | Commercial profile — `country` |
| Contract/commercial reference | Commercial profile — `internalNotes` (free text; this system has no dedicated contract-reference field or document store — record the external contract/quote reference here until one exists) |

### Implementation → Support/Operations

| Field | Where it's recorded |
|---|---|
| Administrator (activated) | `Organization detail → Administrators` table |
| Implementation owner | Commercial profile — `implementationOwner` |
| UAT status | `/platform/organizations/[id]/uat` — cycle result, sign-off |
| Go-live conditions | `Organization detail → External go-live conditions` (4 conditions, each with verifier + timestamp) |
| Known limitations | See `docs/P5_4_LAUNCH_READINESS.md` §5 and this clinic's own onboarding-checklist "optional" items left incomplete |
| Go-live target/actual date | `OrganizationCommercialProfile.goLiveApprovedAt` once approved; a target date beforehand belongs in `internalNotes` (no dedicated target-date field exists) |

### Support/Operations → Clinic

| Field | Where it's recorded |
|---|---|
| Support process | `docs/P5_4_INCIDENT_OPERATIONS.md`, and the in-product `/support` page itself |
| Responsible operator | Whichever platform operator account is assigned to this organization's tickets in practice — no formal per-organization operator assignment field exists in the current schema (see Known Limitations, §4) |

## 3. Handover Checklist

An implementation team can use this alongside the Onboarding Checklist
(`/platform/organizations/[id]/onboarding`) as a plain-language confirmation, one line per stage:

- [ ] Organization, plan, subscription, and entitlements provisioned and confirmed correct
- [ ] Primary and billing contacts recorded
- [ ] Administrator activated
- [ ] Implementation owner assigned
- [ ] All required onboarding checklist items complete (or explicitly, auditedly waived)
- [ ] All required financial configuration gaps resolved (`docs/P5_4_LAUNCH_READINESS.md` §3)
- [ ] Communication templates reviewed (auto-provisioned; confirm the clinic doesn't need
      channel/copy customization before go-live)
- [ ] UAT cycle completed and signed off
- [ ] All 4 go-live conditions verified
- [ ] Go-live approved
- [ ] Support process explained to the clinic's own administrator
- [ ] Clinic confirms normal operation post-go-live

## 4. Known Limitations of This Handover Process

- No dedicated contract/quote reference field, target-go-live-date field, or per-organization
  "assigned support operator" field exists in the schema — each is currently recorded as free text in
  `internalNotes` or tracked outside the product (e.g., in whatever system Sales already uses for
  contracts). Adding structured fields for these is a reasonable, small, future addition if this
  process proves the free-text approach insufficient in practice — not built speculatively here.
- This document describes a process and where its data already lives; it does not add a workflow
  engine, approval chain, or notification system around the handover itself. The go-live approval
  step (`approveGoLive()`) remains the one server-enforced gate in this chain — everything else here
  is an operational checklist, not a system-enforced state machine.
