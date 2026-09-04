# P3.12 — Admin / Settings / Role-Aware Navigation

Consolidation phase: organization settings, branches, users, roles/permissions, master-data configuration, branch context, and navigation. No new clinical, billing, inventory, finance, HR, or notification workflows were built. P3.1–P3.11 were not reopened except where P3.12 itself touched their code paths (dashboards.ts imports, employees.ts's user-link related code, inventory's branch default).

---

## Existing Admin Architecture Traced

**Organization** (`prisma/schema.prisma`): `id, legalName, displayName, defaultCurrency, defaultTimezone, status (active|suspended)`. No branding/logo, contact, or tax/registration fields exist — none were invented. `getOrganization` (gated `settings.view`) and the narrower `getOrganizationIdentity` (any authenticated session, `displayName` only — the pattern already used for invoices/receipts/prescriptions/lab/radiology/payslips) both pre-existed and were preserved unchanged.

**Branch**: `id, organizationId, name, code, timezone, address?, phone?, status (active|inactive)`, `@@unique([organizationId, code])`. No "primary/default branch" concept exists on Branch itself.

**Department** / **Room**: standard status-lifecycle master data (`active|inactive` / `available|occupied|maintenance|inactive`), each scoped one level down (Department→Branch, Room→Department), neither carrying `organizationId` directly.

**User**: `id, organizationId, email, username?, passwordHash, firstName, lastName, status (active|inactive|locked), failedLoginCount, lockedUntil?, lastLoginAt?, mfaEnabled`. Relations: `branchAccess (UserBranchAccess[])`, `roles (UserRole[])`, `sessions`, `loginHistory`, `passwordResetTokens`, `providerProfile? (Provider)`, `employeeProfile? (Employee)`.

**RBAC**: `Role (organizationId, name, isSystemRole)` → `RolePermission` → `Permission (code, category, description — global, not org-scoped)`; `UserRole` links User↔Role. 13 seeded roles (`prisma/seed.ts`'s `SYSTEM_ROLES`): Super Admin, Organization Administrator (both hold every permission — Super Admin additionally gets the `can()`/branch-scope org-wide bypass), Clinic Manager, Receptionist, Doctor, Nurse, Laboratory Technician, Pharmacist, Radiology Technician, Cashier, Accountant, HR Manager, Inventory Manager.

**Session/branch context**: `Session.activeBranchId` already existed (set once at login to the user's first `user_branch_access` row) — several pages (queue, reception, patients/new, appointments/new) already defaulted to it, but nothing let a user change it mid-session.

**Navigation**: `nav-config.ts`'s `NAV_GROUPS` + `app-sidebar.tsx` — already filtered items by `session.permissions` and already hid empty groups (`filter((group) => group.items.length > 0)`); this was correctly implemented before P3.12.

**Existing Admin/Settings pages** (all pre-existing, traced before any change): `/admin/settings` (Organization, Modules, Branches, Departments, Rooms — create-only, no edit/deactivate), `/admin/users` (list, create, status toggle — no post-creation role/branch editing), `/admin/roles` (list, create custom role, edit non-system-role permissions — system-role protection already correct), `/admin/audit`, `/admin/clinical-access-log`, `/admin/system-events` (all three gated on their own real permission, `audit.review`/`audit.review`/`system_events.view`, none held by any operational role).

---

## Organization Settings

Preserved exactly (`legalName`, `displayName`, `defaultCurrency`, `defaultTimezone` — the actual schema fields, nothing invented). Fixed a real §52 gap: `OrgForm` rendered a fully live-looking editable form and "Save changes" button for any `settings.view` holder, including Clinic Manager (who holds `settings.view` but not `settings.edit`) — every field is now `disabled` and the submit button hidden when `canEdit` is false, matching the pattern `PharmacyToggle`/`PortalReleaseToggle` already used.

## Branch Management

Fields shown/edited: `name, code, timezone, address, phone, status` — all real schema fields, nothing invented (no scheduling/roster fields added). Branch deactivation (§9) was schema-ready (`BranchStatus`) but had zero UI — added a status toggle; deactivation only flips `status`, never deletes, verified against a branch carrying a real historical Employee reference (test + browser).

**Decision (§45): `branch.manage`/`department.manage`/`room.manage` are organization-wide administration permissions, not branch-scoped.** Only Super Admin/Organization Administrator hold any of them in seed.ts; `listBranches` already showed every org branch unscoped for the same reason. The previous `updateBranch` required the caller's own `user_branch_access` to already include the target branch — an invented branch-scoped semantic this RBAC doesn't otherwise apply to admin-tier permissions, and one that would force an Org Admin to self-grant branch access before editing a branch they didn't happen to be personally assigned to. Removed that requirement; kept (and fixed) organization-scoping instead.

## User Management

Shown: name, email, roles, branch access, **linked employee** (new column this batch), status, last login — all real fields, no invented last-login tracking (it already existed). `createUser` derives `organizationId` from the session only (the create schema never accepts one). Passwords are hashed before storage and never returned; `listUsers`/`getUser` never select `passwordHash`.

Password reset: unchanged — P0's existing token architecture (`requestPasswordReset`/`confirmPasswordReset`, `NullEmailAdapter`) is Admin-independent (self-service "Forgot password?" only); no Admin-triggered reset/invite button exists or was added, and no external email infrastructure was built.

User deactivation preserves all historical references — `updateUser` only ever changes `status`; no delete path exists or was added. `revokeAllUserSessions` is (unchanged) called on deactivation/lock/role/branch change so a stale session can't keep operating under an old grant.

**New: post-creation role/branch editing** (`EditUserDialog`) — the real §16 gap: creation collected roles/branches, nothing let Admin change them afterward. Verified live: added and removed a fixture branch's access without touching any other user's data.

## Employee/User Linkage — **Implemented**

`Employee.userId` (`@unique`, optional) had domain support (`createEmployee`/`updateEmployee` already accepted it) but no picker anywhere — resolving the named P3.10 backlog item. Added `linkEmployeeUser`/`unlinkEmployeeUser`/`listUnlinkedUsers` (identity/users.ts, gated `users.manage` — Admin-only, not `employee.manage`) and a "Link user"/"Unlink" control on the Employee detail page. Requirements verified (test + browser): same organization only; one User → at most one Employee and vice versa (friendly error on conflict, not a raw constraint violation); no automatic User creation; no silent overwrite (an already-linked employee must be unlinked first); clean unlink→relink.

## Provider/User Linkage

Already had creation-time UI (`new-provider-dialog.tsx`'s "Linked login" picker) — not rebuilt. The real gap: nothing showed it afterward (`getProvider` didn't even select `user`). Added a read-only "Linked login" row to the Provider detail page (this is what `getProviderForUser` — Doctor dashboard, result-notification routing — actually keys off). No automatic Provider creation invented; edit-after-creation deferred (BACKLOG.md).

## Role / Permission Architecture

Custom roles **can** be created (`createRole`) and their permissions edited (`updateRolePermissions`) — confirmed by reading the code, not assumed. System roles (`isSystemRole`) are protected from permission edits (pre-existing, verified still enforced). Permission catalog display improved (§24): each checkbox now shows the human `description` as the primary label with the raw `code` as a small muted mono subtitle — **the stored code is never renamed**, only the label. Categories are the real seed categories (administration/practice/clinical/revenue/insurance/engagement/resources/finance/workforce) rather than an invented finer taxonomy, per "use actual permission codes."

No hidden implied-permission dependency was invented (§25) — a role missing `invoice.view` while holding `invoice.create` still saves exactly as configured. A dependency *warning* (advisory only, never a silent grant) was considered and deliberately deferred — BACKLOG.md.

## User / Role Assignment

`updateUser`'s `roleIds` write path is where a **real, exploitable cross-org privilege-escalation bug** was found and fixed (see Concrete Problems Found). After the fix: same-organization enforcement (a role id from another org is rejected with a friendly message, not a raw FK error), duplicate ids in one submission are deduped (no crash), removal/reassignment works normally for a different user.

## User / Branch Assignment

Same class of bug existed for `branchIds` in both `createUser` and `updateUser` — fixed identically. Duplicates impossible (deduped before write, matching the DB's own `@@unique([userId, branchId])`); removing a branch never touches any historical record (branch access is a pure grant table, no cascading data); every check is server-side (`assertRolesInOrganization`/`assertBranchesInOrganization`), never inferred from what the client happened to submit.

## Privilege Escalation Review

Reviewed and tested (§27/§28):
- **Cross-org role/branch assignment** (the real bug — see below) — closed.
- **Self-escalation**: `updateUser` now rejects a session changing **its own** `roleIds` (any change — grant or removal — not just an increase), with a clear message directing the user to another administrator. Resubmitting the same, unchanged role set is explicitly allowed (a no-op is not an escalation). Self-service branch-access editing was deliberately **not** blocked — the escalation risk named in §28 is about role/permission power, not which branches a session's own reach spans.
- **Cross-org privilege escalation via role assignment**: same fix as above closes this — a Role id genuinely only ever exists in one organization, and it's now checked.
- **System-role protection**: unchanged, verified still enforced (`updateRolePermissions` throws for `isSystemRole`).

No complex RBAC delegation/hierarchy was invented — the fix is a same-organization membership check plus a same-user role-change block, nothing more.

## Last-Admin Safety Review — **Guard added**

No protection existed against an organization deactivating or de-permissioning its own last `users.manage` holder. Added: before a `status` change away from `active` or a `roleIds` change that would leave the target with no `users.manage`-granting role, `updateUser` counts other **active** users in the same organization who currently hold `users.manage` (excluding the target); if zero, the update is rejected with an actionable message. Verified with a fully isolated organization (only that guard's own fixture users) proving the zero-admin case is genuinely rejected, and that adding a second admin lets the operation proceed. Not a general ownership/ordering model — a single narrow count-based guard.

## Department Management — **Implemented**

`createDepartment`/`updateDepartment` were already complete and safe (per P3.10's own finding); the only gap was UI. Added a status toggle next to the existing (pre-P3.12) "Add department" dialog — fields used: `name, code, branch, status`, all real. **Designation management was not built** — designation remains free text on Employee, per explicit instruction.

## Global Branch Context Decision — **Implemented**

`Session.activeBranchId` already existed as real infrastructure, set once at login and never changeable — several pages already read it as a default (queue, reception, patients/new, appointments/new), one page (inventory) had its own independent per-page selector defaulting to `branches[0]` instead. This was exactly the shape §18 asks to inspect before deciding.

**Decision: implement a global switcher, reusing `Session.activeBranchId` rather than introducing new state.** Added `listSwitchableBranches`/`setActiveBranch` (identity/org-structure.ts) and a topbar `BranchSwitcher`, shown only when the session has more than one switchable branch. It is explicitly a navigation preference, not authorization: `setActiveBranch` re-validates the requested branch against the session's authorized set (or, for an org-wide session, against the organization) every time — it can never persist an unauthorized id, and every domain action underneath continues to enforce its own branch scoping independently, unaffected by this preference. Verified live: switching branches persists across a full page reload (DB-backed), and an unauthorized branch id is rejected server-side even when attempted directly against `setActiveBranch` (test).

`Inventory`'s own per-page selector was narrowly updated to prefer `session.activeBranchId` over an arbitrary `branches[0]` when no page-local choice is present (§17) — its own explicit query-param selector still overrides that, unchanged.

---

## Role-Aware Navigation

`AppSidebar`'s permission-based filtering and empty-group hiding were already correct before this batch (verified by reading the code and by the test suite's own group-visibility test, not assumed). What P3.12 verified and fixed:
- **`OrgForm`/Branch/Department/Room "manage" buttons** were rendered regardless of whether the session held the matching `.manage` permission (§52) — now conditionally rendered.
- Every sidebar item's declared `permission` was cross-checked against the real top-of-page gate in its destination route — **all matched exactly**, no mismatches found (a full table was built during tracing; see Direct URL Authorization Verification for the live-tested subset).

## Default Landing Behavior

**Decision: role-aware landing, resolved centrally** (`platform/landing.ts`'s `resolveDefaultLandingRoute`), replacing the hardcoded `/dashboard` fallback in both `src/app/page.tsx` and `login/actions.ts` (via `login()`'s new `redirectTo`). `/dashboard` itself is unchanged and remains safe for every role (already permission-gated per section, `getDoctorDashboard` self-gates to `null` for a non-Provider session) — it was genuinely useless (nothing rendered) for roughly half the seeded roles (Nurse, Lab, Radiology, Pharmacist, Cashier, Inventory Manager), which is the concrete problem this closes.

Resolution uses **permission-code precedence, not role-name matching** — `users.manage` (held only by Super Admin/Organization Administrator) is checked first so a full-permission session never falls through to a job-specific route, then each seeded role's single most-distinguishing permission code in turn, falling back to `/dashboard` for Clinic Manager and anyone unmatched. See the Role Navigation Matrix below for the full mapping, verified with both unit tests (all 11 roles + the "everything + users.manage still wins" case) and live logins.

---

## Role Navigation Matrix

| Role | Visible primary nav (top-level groups) | Landing route | Admin/Settings access |
|---|---|---|---|
| Receptionist | Home, Practice, Revenue, Engagement | `/reception` | None |
| Nurse | Home, Practice, Clinical | `/queue` | None |
| Doctor | Home, Practice, Clinical | `/dashboard` | None |
| Laboratory Technician | Home, Clinical (Laboratory only) | `/laboratory` | None |
| Radiology Technician | Home, Clinical (Radiology only) | `/radiology` | None |
| Pharmacist | Home, Clinical (Pharmacy only), Resources (Inventory) | `/pharmacy` | None |
| Cashier | Home, Practice (Services), Revenue, Engagement | `/pos` | None |
| Inventory Manager | Home, Resources | `/inventory` | None |
| Accountant | Home, Revenue (Invoices/Payments, read-only), Finance, Intelligence | `/accounting` | None |
| HR Manager | Home, Practice (Providers/Services), Resources (Assets), Workforce, Intelligence | `/hr` | None |
| Clinic Manager | Home, Practice, Revenue (Invoices/Payments), Resources, Workforce, Finance, Engagement (Leads), Intelligence, Administration (Settings only) | `/dashboard` | Settings (view-only) |
| Organization Administrator | Every group | `/dashboard` | Full |
| Super Admin | Every group, every organization-scoped record within its own org | `/dashboard` | Full |

(All rows above verified live except Organization Administrator, spot-checked via its identical-permission-set Super Admin twin plus the automated permission-set test — both hold literally the same permission list in seed.ts.)

## Branch Behavior Matrix

| Module | Behavior | Why |
|---|---|---|
| Organization settings | Organization-wide | Organization has no branches of its own |
| Branch/Department/Room management | Organization-wide | `.manage` permissions are admin-tier, held only by org-wide-intended roles (§45 decision above) |
| Users / Roles & Permissions | Organization-wide | Users and Roles are organization-scoped, not per-branch |
| Chart of Accounts, Account Mappings, Accounting Periods | Organization-wide | Unchanged from P3.9 — a clinic's ledger isn't branch-partitioned |
| Accounting overview, Journals, Trial Balance/Income Statement/Balance Sheet | Branch-filterable | Optional branch filter, org-wide view when omitted (unchanged) |
| Patients, Appointments, Reception, Queue | Branch-aware (session-scoped) | `getAuthorizedBranchScope`/`narrowBranchFilter`, unchanged |
| Employees, Attendance, Leave, Payroll | Branch-specific | Each record belongs to exactly one branch (unchanged) |
| Inventory (Stock/Ledger/Transfers) | Branch-specific with explicit selector | Unchanged; now defaults to the session's global preference (§17 fix) before falling back to an arbitrary first branch |
| Global branch switcher itself | User preference only | Never a filter or an authorization boundary — see Global Branch Context Decision |

---

## Direct URL Authorization Verification

Hiding a sidebar item was never treated as the only protection — every page already gates on its own real permission at the top (`can(session, "...") ` → `redirect("/dashboard")`), independent of what the sidebar renders. Live-tested via direct navigation (bypassing the sidebar entirely) for all 11 seeded operational roles plus Super Admin:

| Role | Unauthorized URL attempted | Result |
|---|---|---|
| Receptionist | `/accounting` | Redirected to `/dashboard` |
| Nurse | `/payroll` | Redirected to `/dashboard` |
| Doctor | `/accounting` | Redirected to `/dashboard` |
| Laboratory Technician | `/pharmacy` | Redirected to `/dashboard` |
| Radiology Technician | `/accounting` | Redirected to `/dashboard` |
| Pharmacist | `/accounting` | Redirected to `/dashboard` |
| Cashier | `/pharmacy` | Redirected to `/dashboard` |
| Inventory Manager | `/accounting` | Redirected to `/dashboard` |
| Accountant | `/pharmacy` | Redirected to `/dashboard` |
| HR Manager | `/accounting` | Redirected to `/dashboard` |
| Clinic Manager | `/admin/users` | Redirected to `/dashboard` |

All 11 also confirmed to land on a non-crashing page (their own designated landing route) and to render `/dashboard` without error where applicable. The automated suite additionally covers the domain-function layer directly (`ForbiddenError` on cross-org/self-escalation/unauthorized-role attempts), which a browser click can't exercise as precisely as a direct function call with a tampered id.

---

## Concrete Problems Found

1. **Cross-organization role/branch assignment (real privilege-escalation bug).** `createUser`/`updateUser` wrote every submitted `roleId`/`branchId` straight into `user_role`/`user_branch_access` with no check that the id belonged to the caller's own organization. A `users.manage` holder in one org could grant a user in their own org a Role or Branch id borrowed from **any other organization** in the database — genuine cross-tenant privilege escalation, not a hypothetical. Fixed with explicit `assertRolesInOrganization`/`assertBranchesInOrganization` checks before every write.
2. **Cross-organization Branch/Department/Room tampering.** `updateBranch` fetched/updated by bare id with no `organizationId` filter at all. `updateDepartment`/`updateRoom` had **no organization check whatsoever** (Department/Room carry no `organizationId` column directly) — any org's `department.manage`/`room.manage` holder could edit **any other organization's** department or room by id, and `createRoom`/`createDepartment` accepted a `departmentId`/`branchId` with no ownership check either. All five fixed by joining through the owning Branch (the only place these models carry organization identity) and validating explicitly.
3. **No self-escalation protection.** A `users.manage` holder could change their own role assignment with no restriction — including granting themselves a more powerful role. Fixed (see Privilege Escalation Review).
4. **No last-admin protection.** An organization could deactivate or de-permission its own only `users.manage` holder, with no recovery path in this codebase. Fixed with a narrow guard (see Last-Admin Safety Review).
5. **`/dashboard` was the only landing route, and was empty for ~6 of 11 operational roles.** Fixed with permission-based role-aware landing.
6. **Write controls rendered regardless of permission** (`OrgForm`'s always-visible "Save changes"; Branch/Department/Room "Add ..." dialogs shown to `settings.view`-only sessions like Clinic Manager). Fixed — each is now conditional on the actual `.manage`/`.edit` permission.
7. **Provider's linked login was invisible everywhere after creation** — the field `getProviderForUser` (Doctor dashboard, result notifications) actually depends on had no display surface at all. Fixed with a read-only row.
8. **No friendly error messages for username/email duplication, role/permission-id-not-found, or cross-org assignment** — these previously either succeeded silently wrong or surfaced a raw Prisma constraint message. Fixed across `createUser`/`updateUser`/`createRole`/`updateRolePermissions`.

## Improvements Implemented

- Global branch switcher (topbar), backed by the pre-existing `Session.activeBranchId`.
- Role-aware default landing (`resolveDefaultLandingRoute`), used by both direct navigation (`/`) and post-login redirect.
- Employee↔User linkage UI (link/unlink), Admin-only.
- Provider↔User linkage now visible (display, not yet editable — BACKLOG.md).
- Post-creation User role/branch editing (`EditUserDialog`).
- Branch and Department status (deactivate/reactivate) toggles.
- Permission-catalog friendly labels (description primary, code secondary) on both the role editor and the new-role dialog.
- A coherent "configuration areas" quick-link row on `/admin/settings`, permission-gated per link, linking to (not duplicating) Users/Roles/Audit/Clinical Access Log/System Events.
- "Linked employee" column added to the Users list.
- Topbar user menu now shows the session's role name(s) alongside name/email (display-only).
- Inventory's own branch default now prefers the session's global branch preference over an arbitrary first branch.

---

## Security

- **Cross-organization isolation**: explicitly tested (automated + a subset live) for editing another org's Branch/Department/Room, assigning another org's Role, assigning another org's Branch, and linking another org's Employee/User — all rejected server-side.
- **Self-escalation**: tested — a session cannot change its own role assignment; an unchanged resubmission is allowed.
- **Last-admin safety**: tested against a fully isolated organization — the zero-remaining-admin case is genuinely rejected, not merely believed to be.
- **Branch scoping**: `branch.manage`/`department.manage`/`room.manage` deliberately documented as organization-wide (§45) rather than invented as branch-scoped; every write still verifies organization membership regardless.
- **No new permission codes were introduced** — every fix above reuses `users.manage`/`branch.manage`/`department.manage`/`room.manage`/`settings.edit`, all pre-existing.
- **No secrets exposed**: no DB URLs, encryption keys, SMTP credentials, or API keys are represented in any Admin page (confirmed — `/admin/settings` and `/admin/system-events` are the only "system-adjacent" surfaces, and neither reads environment configuration); no secret-manager work was needed or built.

## Performance

- The global branch switcher, role-name display, and landing-route resolution all read from the session's already-resolved `permissions`/`roleNames`/`branchIds` — zero additional permission or role queries per navigation item or per row.
- `listSwitchableBranches` is one query per layout render (not per nav item), matching the existing `getUnreadCount` discipline already in `(dashboard)/layout.tsx`.
- `resolveDefaultLandingRoute` is pure/synchronous — no DB access at all.
- No new indexes were added — no query pattern introduced by this batch justified one (the cross-org validation queries use existing PK/`@@unique` lookups).

## Files Changed

**New:**
- `src/lib/platform/landing.ts` — `resolveDefaultLandingRoute`
- `src/components/layout/branch-switcher.tsx` — topbar `BranchSwitcher`
- `src/app/(dashboard)/admin/settings/status-toggle.tsx` — Branch/Department status toggles
- `src/app/(dashboard)/admin/users/edit-user-dialog.tsx` — post-creation role/branch editing
- `src/app/(dashboard)/employees/[id]/user-link-dialog.tsx` — Employee↔User link/unlink UI
- `test/integration/p3-12-admin-settings-role-aware-navigation.test.ts`

**Modified:**
- `src/lib/domains/identity/org-structure.ts` — cross-org fixes (Branch/Department/Room), org-wide `.manage` decision, `listSwitchableBranches`/`setActiveBranch`
- `src/lib/domains/identity/users.ts` — cross-org role/branch validation, self-escalation guard, last-admin guard, Employee↔User linkage, friendly errors, `listUsers`/`getUser` now include `employeeProfile`
- `src/lib/domains/identity/roles.ts` — permission-id validation, friendly duplicate-name error
- `src/lib/domains/providers/service.ts` — `getProvider` now includes linked `user`
- `src/lib/auth/service.ts` — `login()` resolves and returns `redirectTo`
- `src/app/login/actions.ts`, `src/app/page.tsx` — use `resolveDefaultLandingRoute`
- `src/app/(dashboard)/layout.tsx` — fetches switchable branches, passes role names to Topbar
- `src/app/(dashboard)/actions.ts` — `switchBranchAction`
- `src/components/layout/topbar.tsx` — branch switcher + role-name display
- `src/app/(dashboard)/admin/settings/page.tsx`, `org-form.tsx`, `actions.ts` — permission-gated write controls, status toggles, quick-links row
- `src/app/(dashboard)/admin/users/page.tsx`, `actions.ts`, `status-toggle.tsx` — Edit dialog wiring, linked-employee column, error surfacing
- `src/app/(dashboard)/admin/roles/new-role-dialog.tsx`, `role-permission-editor.tsx` — friendly permission labels
- `src/app/(dashboard)/employees/[id]/page.tsx`, `actions.ts` — Link/Unlink user wiring
- `src/app/(dashboard)/inventory/page.tsx` — session-preferred branch default
- `src/app/(dashboard)/providers/[id]/page.tsx` — "Linked login" display row
- `BACKLOG.md`

## Tests

New: 40 (`p3-12-admin-settings-role-aware-navigation.test.ts`), covering organization-settings authorization, branch/department/room cross-org rejection, branch deactivation historical safety, department status toggle, the global branch switcher (authorized/unauthorized/org-wide), user-creation organization derivation, duplicate-email friendly error, cross-org role/branch assignment rejection (create and update), duplicate-id dedup, normal role assignment to another user, self-escalation rejection (and allowed no-op), last-admin safety (positive case in the shared org + isolated-org zero-admin proof), Employee↔User linkage (link/duplicate-rejection/cross-org-rejection/unlink/relink), role-permission validation (nonexistent id, duplicate name, system-role protection), permission-based landing resolution for all 11 seeded roles plus the "users.manage always wins" case, dashboard-section safety for a permission-less session, and role-aware sidebar filtering (no empty groups, correct module hiding) for all 11 roles.

**Total: 54 test files, 421 tests, 421 passing** (381 baseline + 40 new).

## Browser Verification

All performed against `his_dev`, using temporary fixtures (a second branch, 11 role-specific users, one HR-fixture user, one employee) created and fully removed via a setup/cleanup script pair (confirmed removed — Users back to 1, Employees back to 0, branch switcher gone).

- **Organization/Branch**: logged in as Organization Administrator (`admin@avant.local`); reviewed Settings; deactivated then reactivated the Main Branch, confirming the button and badge updated correctly; created a fixture branch; confirmed it appeared in Branches and became switchable in the topbar.
- **Users**: opened Users; created a fixture HR Manager user with roles + branch access; used the new Edit dialog to add and then remove the fixture branch, confirming the change persisted each time without affecting the other user.
- **Employee/User Link**: created a fixture Employee; linked it to the fixture user (confirmed "System login" updated); confirmed unlink correctly cleared it back to "Not linked."
- **Roles/Permissions**: confirmed friendly grouped permission labels render correctly; confirmed system-role checkboxes are disabled with no save control; privilege-escalation rejection confirmed via the automated test suite as instructed (§66 step 22).
- **Department**: toggled the seeded "General" department's status via the new control, confirmed it updated and reverted cleanly.
- **Navigation**: for Receptionist, Nurse, Doctor, Laboratory Technician, Radiology Technician, Pharmacist, Cashier, Inventory Manager, Accountant, HR Manager, and Clinic Manager — logged in, recorded the landing route, confirmed no crash on the landing page, inspected the sidebar (Clinic Manager's shown in full above), and attempted one representative unauthorized direct URL per role (table above) — all denied.
- **Branch Context**: verified the switcher only lists authorized branches, that switching persists across a full reload, and that only branches genuinely in the org appear even for the org-wide (Super Admin) session.

## Remaining Admin/Settings Backlog

See `BACKLOG.md` for full detail on each — summarized: branch deactivation doesn't yet filter inactive branches out of other modules' pickers (low severity, no data-integrity risk); Provider↔User linkage can be set at creation but not edited afterward (display gap now closed); no permission-dependency warning UI (advisory-only per §25, explicitly deferred); Employee self-service, jurisdiction adapters, and the other pre-existing P3.10/P3.11 items remain untouched and out of this phase's scope.

## Regression Status

- `npx prisma validate` — clean
- `npx prisma migrate status` — 34/34 migrations applied, database schema up to date (no schema changes this batch)
- `npm run typecheck` — clean
- `npm run lint` — clean
- Integration suite — **54 files, 421 tests, 421 passing**
- `npm run build` — clean, 66 routes

Integration test database:
- Host: `localhost`
- Port: `5433`
- Database: `his_test`
- Remote Supabase: **NOT USED**

No credentials included above or elsewhere in this report.

---

Per §70: stopping here. Not beginning P3.13, P4, or regulatory implementation, and no whole-project audit was performed. Awaiting review and explicit instruction to continue.
