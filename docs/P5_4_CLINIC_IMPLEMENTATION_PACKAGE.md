# P5.4 — Standard Clinic Implementation Package

Reference for an implementation team taking a new clinic from "sold" to "operating." Every claim
below is verified directly against the current code (`src/lib/domains/commercial/provisioning.ts`,
`src/lib/domains/commercial/onboarding-checklist.ts`), not assumed — nothing is listed as automatic
unless `provisionClinic()` actually creates it.

## 1. Automatically Provisioned

Created in one atomic transaction the moment a platform operator submits `/platform/provision`, plus
two immediate follow-up steps that run right after (module entitlements and the onboarding
checklist/communication templates are additive and non-transactional by design — see the code
comments at `provisioning.ts`'s own call sites for why: a failure there never leaves an organization
with no working administrator):

| Item | Created by |
|---|---|
| Organization | `provisionClinic()` |
| Initial branch | `provisionClinic()` |
| System roles (Super Admin, Receptionist, Doctor, Nurse, Pharmacist, Laboratory Technician, Radiology Technician, Cashier, Accountant, HR Manager, Inventory Manager, Clinic Manager) | `provisionClinic()` (`bootstrapSystemRoles`) |
| Initial administrator (Super Admin) | `provisionClinic()` — receives a one-time activation link, never a plaintext password |
| Commercial profile (customer code, country, contacts) | `provisionClinic()` |
| Subscription (plan, status, dates, limits) | `provisionClinic()` |
| Module entitlements | `provisionClinic()` → `seedModuleEntitlementsFromPlan()`, from the selected plan's default module set |
| Onboarding checklist | `provisionClinic()` → `ensureOnboardingChecklist()` — seeded pending, entitlement-filtered (see §3) |
| Go-live conditions (4: hosted backup + restore rehearsal, external error monitoring, clinic-specific UAT, transactional email) | `provisionClinic()` — seeded `pending`, never auto-completed |
| **Communication templates** (appointment confirmation, appointment cancellation, appointment reminder, birthday greeting, plus payment reminder when POS/Billing or Finance is enabled) | `provisionClinic()` → `ensureCommunicationTemplates()` — **new in P5.4**; closes the real gap P5.3's UAT found (a freshly-provisioned clinic previously had none, and every appointment notification silently dead-lettered forever) |

Both the onboarding checklist and communication templates are also **self-healing on every
organization-detail page load** (`getOrganizationCommercialDetail`), not just at provision time — an
organization provisioned before this backfill existed (including P5.3's own pilot org) catches up
automatically the next time an operator opens it.

## 2. Manually Configured

Nothing below is created by provisioning. Each is a real, deliberate implementation step — confirmed
by inspection, not inferred — and each (except where noted) is also tracked as its own row in the
Onboarding Checklist (`/platform/organizations/[id]/onboarding`), so an implementation team has a
single, persistent, audited place to see what's left rather than needing this document open at all
times.

| Item | Where | Checklist item |
|---|---|---|
| Additional branches | Admin → Settings → Branches | `additional_branches` (optional) |
| Required staff accounts (reception, clinical, etc.) | Admin → Users | `required_staff_added` (required) |
| Providers (doctors/practitioners), linked to their user login | Providers | `providers_added` (optional, but practically required for any clinical module) |
| Services (billable consultations/procedures) | Services | `services_configured` (required) |
| Products | Inventory | `products_configured` (required if `inventory` enabled) |
| Suppliers | Purchasing → Suppliers | `suppliers_configured` (optional, if `procurement` enabled) |
| Medications | Pharmacy | `medications_configured` (required if `pharmacy` enabled) |
| Lab catalogue | Laboratory | `lab_catalogue_configured` (required if `laboratory` enabled) |
| Imaging catalogue | Radiology | `imaging_catalogue_configured` (required if `radiology` enabled) |
| Packages | Packages | `packages_configured` (optional) |
| Payors (insurance) | Payors | `payors_configured` (optional) |
| Chart of Accounts + Account Mappings | Accounting | `chart_of_accounts_configured` (required if `finance` enabled) — **P5.4 §4 now detects specifically which mappings are missing, based on which modules are actually enabled**, rather than leaving this as an all-or-nothing checklist tick; see `docs/P5_4_LAUNCH_READINESS.md` |
| Opening inventory | Admin → Onboarding → Import | `opening_inventory_imported` (optional, if `inventory` enabled) — via the real P4.6 CSV import framework |
| Assets | Assets | `assets_configured` (optional, if `assets` enabled) |
| HR configuration (departments, shifts, leave policies) | HR | `hr_configuration` (optional, if `hr` enabled) |
| Branch-specific account-mapping overrides | Accounting → Account Mappings | not separately tracked — an org-wide default is sufficient for go-live; a branch override is an optional refinement, never a requirement (`resolveAccountId`'s own fallback) |

## 3. Optional by Entitlement

The onboarding checklist itself is entitlement-filtered — an item tagged with a `moduleKey` only
appears (and only counts toward "required") when that module is actually enabled for the
organization:

| Module | Gates |
|---|---|
| `inventory` | Products, opening inventory import |
| `procurement` | Suppliers |
| `pharmacy` | Medications |
| `laboratory` | Lab catalogue |
| `radiology` | Imaging catalogue |
| `finance` | Chart of Accounts / Account Mappings |
| `assets` | Assets |
| `hr` | HR configuration |
| `pos_billing` or `finance` | Payment Reminder communication template (the only one of the 5 default templates that's conditional — see §1) |

`reception`, `patients`, `appointments`, `clinical`, and `nursing` are **never gateable** — they are
the core clinical spine (`isRouteEnforceable`/`CORE_MODULES`, `entitlements-shared.ts`) and always
apply regardless of plan.

## 4. Configuration Templates / Defaults (P5.4 §2)

What can safely be standardized across every clinic, vs. what must stay clinic-specific — assessed
against the existing architecture, not implemented speculatively:

**Already a safe global default (no change needed):** appointment statuses
(`AppointmentStatus`/`APPOINTMENT_STATUS_LABEL`) and tender/payment methods (cash, card, bank,
online, insurance, credit, other) are fixed, universal vocabularies already shared by every
organization — never clinic-configurable, so there was nothing to standardize further.

**Now a safe global default (P5.4 §3, this phase):** communication templates. Generic operational
copy (no price, tax, clinical, or regulatory content) that's safe as a universal starting point and
reasonable as-is for immediate use, while remaining a normal, editable `CommTemplate` row per
organization — see §1.

**Correctly NOT auto-seeded, and no code was added to do so:** Chart of Accounts / Account Mappings.
Per this phase's own explicit instruction — "do not create mappings automatically if doing so could
select the wrong account" — P5.4 built *detection* (`docs/P5_4_LAUNCH_READINESS.md`), never
auto-creation, of financial configuration. An account mapping is a real business decision (which GL
account a clinic's own bookkeeping calls "Bank," what account "Cost of Goods Sold" rolls up to) that
depends on a chart of accounts a real clinic supplies, not something this system can safely guess.

**Correctly remain clinic-specific (unchanged):** service/product prices, tax rates, medication
formularies, physician commission rates, insurance contract terms, and any other business-specific
value — none of these are seeded, and P5.4 introduces no mechanism that would.

## 5. Using This Document

An implementation team's actual workflow is the Onboarding Checklist itself
(`/platform/organizations/[id]/onboarding`), not this file — the checklist is live, per-organization,
audited, and entitlement-filtered; this document exists to explain *why* each item exists and which
ones a plan's module selection will or won't surface, so a new implementer isn't guessing at what
"required" means for a given clinic's actual purchased plan.
