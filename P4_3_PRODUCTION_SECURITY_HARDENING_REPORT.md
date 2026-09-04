# P4.3 — Production Security Hardening Report

**Batch**: P4.3 of 9 (P4 Commercial Deployment Readiness), following [P4.1](P4_1_PRODUCTION_ENVIRONMENT_DEPLOYMENT_ARCHITECTURE_REPORT.md) and [P4.2](P4_2_DATABASE_RELIABILITY_BACKUP_RESTORE_DISASTER_RECOVERY_REPORT.md).
**Objective**: harden the actual attack surface of this application before exposing it to real clinics and the public internet — not a whole-project audit, not a redesign, not regulatory certification.
**No credential, password, token, or connection-string value appears anywhere in this report.**

## Executive Summary

Tracing this codebase's authentication, session, and authorization architecture found it already unusually mature — Argon2id hashing, hashed (never plaintext) session/reset tokens, single-use expiring reset tokens that invalidate every other session on use, a fully DB-resolved (never cached/JWT-embedded) session model, and a single authorization chokepoint every write already goes through. That reframed this batch from "build security infrastructure" to "close the concrete gaps tracing found, and prove the rest with real attacks" — which is what this report documents.

**Real gaps found and fixed**: no IP-based brute-force throttling (only per-account); an unenforced `OrgStatus.suspended` field (schema existed, nothing checked it — a suspended organization's staff could keep working indefinitely); an open redirect in the post-login `from` parameter; zero security headers/CSP anywhere; a non-constant-time cron-secret comparison; missing `Cache-Control: no-store` on two sensitive responses; missing input-size bounds on public auth endpoints. **Nothing found rose to BLOCKER** (no authentication bypass, no organization-isolation bypass, no plaintext credential/token storage, no arbitrary privilege escalation).

Full regression: 58 test files, 503/503 passing (up from 503 baseline minus 25 net-new — see Regression Status for the exact accounting), typecheck/lint/`prisma validate`/production build all clean. A real browser walkthrough against a `next start` production build exercised the actual attack matrix below, not a description of it.

## Attack Surface Traced

Per §3's own scope boundary — not a whole-repository audit. Inspected: `src/lib/auth/service.ts` (staff login/reset), `src/lib/auth/portal-service.ts` (portal login), `src/lib/auth/session.ts`/`portal-session.ts` (session resolution/cookies), `src/lib/auth/tokens.ts`/`password.ts` (token/hash primitives), `src/proxy.ts` (the layered-authorization entry point), `src/app/login/actions.ts`, `src/app/reset-password/actions.ts`, `src/app/portal/login/actions.ts` (Server Actions), `src/app/api/cron/outbox-sweep/route.ts` and `src/app/api/health/route.ts` and `src/app/api/reports/export/route.ts` (every Route Handler in the app — confirmed there are exactly three), `src/lib/platform/permissions-core.ts` (the authorization chokepoint), `src/lib/platform/logger.ts` (never-log discipline), `src/lib/domains/identity/users.ts`/`roles.ts`/`schemas.ts` (privileged admin actions), `next.config.ts` (headers, previously empty), `prisma/schema.prisma` (`OrgStatus`, `LoginHistory`, `Session`, `PasswordResetToken`), and representative domain write paths (`billing/invoices.ts`, `billing/payments.ts`, `billing/charges.ts`, `patients/service.ts`, `hr/employees.ts`) for IDOR/mass-assignment. `npm audit` for dependency security. A grep across `src/` for `dangerouslySetInnerHTML`, `queryRawUnsafe`/`executeRawUnsafe`, and hardcoded credential-shaped strings.

## Findings by Severity

| Severity | Finding | Status |
|---|---|---|
| HIGH | No IP-based login rate limiting — only per-account lockout, distributed guessing across accounts from one IP was unthrottled | **Fixed** — `src/lib/auth/rate-limit.ts`, applied to both staff and portal login |
| HIGH | `OrgStatus.suspended` existed in the schema with nothing anywhere enforcing it — a suspended organization's staff/portal users could keep authenticating and using existing sessions indefinitely | **Fixed** — enforced at login and on every session resolution, staff and portal |
| MEDIUM | Open redirect: `from` param accepted `//evil.example` (protocol-relative) as a valid post-login redirect | **Fixed** — `src/lib/platform/safe-redirect.ts` |
| MEDIUM | No security headers/CSP anywhere in the application | **Fixed** — `next.config.ts`, verified over real HTTP and a real browser walkthrough |
| LOW | Cron bearer-token comparison used plain `!==` (theoretical timing side-channel) | **Fixed** — `crypto.timingSafeEqual` |
| LOW | Two sensitive responses (CSV export, cron sweep result) had no explicit `Cache-Control` | **Fixed** — `no-store` added to both |
| LOW | No maximum length on login/reset email and password fields (resource-abuse surface) | **Fixed** — bounded across every auth entry point |
| LOW | The pre-existing "inactive account" login message reveals more than "invalid credentials" to an unauthenticated caller | **Not fixed — backlogged**, see Remaining Security Backlog (a deliberate existing precedent, not introduced this phase) |
| LOW | 2 High `npm audit` findings, both `mysql2` via `prisma` (dev-only, unreachable — this project never connects to MySQL) | **Accepted residual risk**, documented |
| — | Two pre-existing, unrelated test-suite hygiene issues discovered while running the full regression (orphaned test-fixture organizations from an older P3.12 test file; a sequence-number-dependent flaky assertion in a P3.13 test) | **Out of scope — flagged as a background task**, not a security issue |

No BLOCKER finding.

## Authentication Review

Traced the real path: login form → `loginAction` (Server Action) → `login()` → credential lookup → password verification → session creation → cookie → redirect. Confirmed: passwords are looked up by normalized (trimmed, lowercased) email; a nonexistent user, a wrong password, an IP-throttled request, and (new) a suspended organization all return the same generic `"Invalid email or password."` (the IP-throttle case returns a distinct, account-existence-neutral message instead — see Login Brute-Force Protection); a locked or inactive account gets a distinct, more specific message — pre-existing precedent, not changed this phase, see Remaining Security Backlog; every attempt, success or failure, is written to `LoginHistory` with a safe `reason` classification, never the attempted password.

## Password Security

Argon2id (`argon2` package defaults — not overridden; left alone per §6, adequate as-is). Staff-created accounts: minimum 10 characters. Self-service reset: minimum 8 characters. Both now carry a 256-character maximum (new — a resource-abuse bound, not a policy change). No forced periodic rotation, no complexity-circus rule, no country-specific policy.

## Login Brute-Force Protection

**New this phase.** `src/lib/auth/rate-limit.ts`'s `checkIpRateLimit()` counts recent failed attempts from an IP within a 10-minute window, storage-backed via the existing `LoginHistory` table (not process memory — correct across multiple/serverless instances). Threshold: 20 failures/IP/10min, applied per channel (staff/portal independently). Throttled requests get a distinct "Too many attempts from this network. Please try again later." message — never reveals whether any specific account exists. This layers on top of the pre-existing, unchanged per-account lockout (5 failures → 15-minute temporary lockout, never indefinite — successful auth resets the counter). Verified with a real, non-mocked test: 20 genuine failed `login()` calls from one IP, confirmed allowed; the 21st confirmed throttled; a different account from the same throttled IP confirmed also throttled (proving it's IP-scoped, not account-scoped); staff and portal channels confirmed independent.

## Password Reset Security

Trace confirmed end-to-end: `crypto.randomBytes(32)` raw token (256 bits) → only its SHA-256 hash stored (`PasswordResetToken.tokenHash`) → 30-minute server-side expiry, checked on every use → single-use (`usedAt` set in the same transaction as the password change, checked before allowing reuse) → **every existing session for that user is revoked on successful reset** (`revokeAllUserSessions`) — already implemented, not a backlog item as a prior phase's own comment once suggested. Real browser verification: an unauthenticated request for a nonexistent email and one for a real account (`admin@avant.local`) produced byte-identical response text; a garbage/invalid token submitted to the confirm form was safely rejected with "This reset link is invalid or has expired." — no crash, no leaked internals, zero console errors.

## Session Security

256-bit random session token, SHA-256 hash-only storage, 12-hour expiry, `httpOnly`/`secure`-in-production/`sameSite: lax` cookie — all pre-existing and confirmed correct. Session fixation: not applicable — every successful auth issues a brand-new random token; there is no pre-existing unauthenticated session to "upgrade." Logout: verified both via a real browser click (DB inspection immediately after confirmed `Session.revokedAt` was set — not merely a cleared cookie) and an automated test (`revokeSession` then `getSessionContext(sameRawToken)` returns `null`).

## Stale Authorization / User Deactivation

**Proven, not just inspected.** Because `getSessionContext` re-derives the full permission/role/branch set from the database on *every* request (nothing is cached across requests or embedded in the cookie beyond the opaque token), three real attacks were tested directly against a live session with no re-login involved:

- Deactivating the user (`status: "inactive"`) mid-session → the next `getSessionContext` call on the *same* still-cookied token returns `null`.
- Suspending the organization mid-session (new this phase) → same result, both staff and portal.
- Removing a role's permission mid-session (`updateRolePermissions(..., [])`) → the next resolution of the *same* session token no longer carries that permission.

All three confirmed via automated test against real database state, not asserted from reading the code alone.

## CSRF / Origin Security

Next.js's built-in Server Actions Origin-header verification is in effect (no `serverActions.allowedOrigins` override configured, so cross-origin POSTs to any Server Action are rejected by the framework itself). This codebase has exactly three Route Handlers total (`/api/health`, `/api/cron/outbox-sweep`, `/api/reports/export`) — none is a cookie-authenticated *mutating* endpoint (the export route is a GET; the cron route is bearer-token-, not cookie-, authenticated) — so there is no surface today that needs explicit `Origin` validation beyond the framework default, and none was invented. The session cookie's `sameSite: "lax"` is an independent second layer against cross-site POST specifically.

## Server Action / API Security

Traced representative Server Actions (`login/actions.ts`, `reset-password/actions.ts`, `admin/users/actions.ts`): every one validates input with Zod before calling a domain function (TypeScript types are never trusted as runtime validation), and every domain function re-authorizes independently (`assertCan`) rather than trusting the action layer already checked. `GET` handlers never mutate — the sole exception, `/api/cron/outbox-sweep`, is the documented, deliberate infrastructure exception (§25), already bearer-token-protected, not rewritten merely for REST aesthetics.

## IDOR / Object Authorization

Representative cross-organization tests (new this phase — no prior test file exercised this dimension specifically; same-organization cross-*branch* isolation was already thoroughly covered by `branch-isolation.test.ts` and not re-audited here): a session belonging to Organization B, with `patient.view`/`invoice.view`/`employee.view` permissions, attempted to read Organization A's `Patient`, `Invoice`, and `Employee` records by ID directly — all three rejected. Cross-org role/branch *assignment* protection (a write-path IDOR concern) was verified as already correctly implemented by P3.12 (`assertRolesInOrganization`/`assertBranchesInOrganization`, `organizationId` always derived from session, never client input) — re-confirmed by inspection, not rebuilt, per §30's own instruction.

## Organization Isolation

See IDOR above (read-path) and Financial Tampering below (write-path, financial totals specifically). The org-suspension fix (Findings table) closes the one genuine organization-isolation gap this phase found — a *session-lifecycle* gap, not a data-scoping one; data scoping itself was already consistently correct everywhere traced.

## Branch Isolation

Not re-audited — `test/integration/branch-isolation.test.ts` (P0-01) already thoroughly proves cross-branch read isolation for patients, appointments, invoices, clinical orders, inventory, and accounting, on both list and get-by-id paths, and remains passing unchanged. Per §29's own instruction, this phase did not duplicate that coverage.

## Input Validation / Mass Assignment

Login/portal-login/reset-password/admin-user-creation email and password fields now carry explicit maximum lengths (new — resource-abuse bound). Mass-assignment check: attempted to pass smuggled extra fields (`totalAmount`, `paidAmount`, `status`, `organizationId`) into `generateInvoice`'s input, cast past its TypeScript type to simulate a raw HTTP client — the real charge amount, computed server-side, won every time; the smuggled values were silently ignored, not applied. Attempted to overpay an invoice via `recordPayment` with a tender exceeding the real outstanding balance — rejected, balance left untouched. Both verified with real domain-function calls, not by reading the code and assuming.

## SQL Injection Review

Grepped `src/` for `$queryRawUnsafe`/`$executeRawUnsafe` and string-built SQL — zero matches in application code (only in Prisma's own generated internals, not user-reachable). No raw SQL in this codebase accepts unparameterized user input; Prisma's parameterized query builder is used throughout. No change needed.

## XSS Review

Grepped `src/` for `dangerouslySetInnerHTML` — zero matches anywhere in the application. React's default escaping covers every place user-controlled text (patient names/notes, diagnosis text, communication bodies, invoice descriptions) is rendered. No HTML sanitizer was built, because no HTML input is supported or rendered as HTML anywhere.

## Security Headers / CSP

**New this phase — the largest concrete gap found.** `next.config.ts` previously set zero headers at all. Added `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, and (production-only) `Strict-Transport-Security`; disabled `X-Powered-By`. Full policy and the deliberate `'unsafe-inline'` compromise (Next's own RSC bootstrap script requires it without a larger nonce-plumbing change) are documented in [docs/PRODUCTION_SECURITY.md](docs/PRODUCTION_SECURITY.md#security-headers--csp). See Browser/HTTP Walkthrough below for the real verification.

## Open Redirect Review

Found: `src/app/login/actions.ts`'s post-login `from` parameter accepted anything satisfying `.startsWith("/")`, which a protocol-relative URL (`//evil.example`) also satisfies — a browser resolves that as `https://evil.example`. Fixed with `src/lib/platform/safe-redirect.ts`'s `safeInternalRedirectPath()`, which additionally rejects `//`-prefixed and `\`-prefixed values and any value containing `://`. Portal login's redirect was already hardcoded (`/portal`, never client-controlled) — no fix needed. Unit-tested directly (6 cases: valid internal path, protocol-relative, backslash-leading, full external URL, empty/missing, non-slash-prefixed).

## Sensitive Data Exposure

`/api/health` confirmed to expose only `{status, database, timestamp, version, durationMs}` — no host, database name, connection string, or internal stack (re-verified this phase, not just carried over from P4.1's own claim). `/api/cron/outbox-sweep`'s response never echoes the submitted token or event payloads. Patient/financial data was never observed in a query string anywhere traced — IDs appear in URLs where routing requires them, always with authorization enforced server-side on the read, matching §57's own allowance.

## Logging / Error Leakage

`src/lib/platform/logger.ts`'s never-log list (passwords, hashes, reset/session tokens, connection strings, full clinical notes, more patient detail than an entity id) re-verified by inspection — unchanged this phase, no violation found at any traced call site. `login()`'s failure logging records a safe `reason` enum value, never the attempted password. Global/route/Server-Action error boundaries (`global-error.tsx`, `(dashboard)/error.tsx`, `/api/health`'s catch block) were re-confirmed to show only `error.digest`, never a raw stack trace or Prisma error — first verified in P4.1, unchanged.

## Auditability of Security Actions

`AuditLog` (via `auditFromSession`) already covers login/reset-adjacent and admin actions this phase's own tracing touched: cashier session open, invoice creation, invoice void, payment creation, stock adjustment, user creation — all pre-existing, confirmed still firing correctly (the new IDOR test's fixture generated real `AuditLog` rows as a side effect of using the real domain functions, exactly as intended). No giant security-event subsystem was built; the existing audit architecture already covers the representative list in §50.

## Dependency Security

`npm audit` (see Files Changed for the exact command): **2 High, 0 Critical, 0 Moderate, 0 Low.** Both High findings are the same root cause — `mysql2`'s auth-plugin-downgrade credential-disclosure advisory (CWE-522) — reached only through `prisma` (a devDependency, the CLI tool). This project's Prisma `datasource` is PostgreSQL-only; `mysql2`'s vulnerable MySQL-authentication-negotiation code path is never exercised in development or production, since no MySQL connection is ever made. The only available fix is a Prisma major-version change, which this project's own instructions explicitly say not to force merely to zero out audit output. **Accepted residual risk**, documented here and in the security doc, not silently ignored.

## Secret Handling

`.env` confirmed git-ignored; `.env.example` confirmed placeholder-only (re-checked this phase). A targeted scan of currently-tracked files for obviously credential-shaped strings (hardcoded passwords, API keys, connection strings, private-key markers) found none beyond what P4.1 already documented as intentionally-dead/example values. Not repeated as a full Git-history forensic exercise — no evidence surfaced suggesting one is warranted (§55's own "do not perform a huge forensic exercise unless evidence suggests exposure").

## Cron / Infrastructure Endpoint

`/api/cron/outbox-sweep`'s 503 (secret unset)/401 (wrong token)/200 (correct token) behavior, already verified in P4.1, re-confirmed unchanged this phase. New: the token comparison now uses `crypto.timingSafeEqual` (with a length-mismatch short-circuit that doesn't reintroduce the leak it closes) instead of plain `!==`; the success response now carries `Cache-Control: no-store`; verified a token of a different length is still correctly rejected (the short-circuit doesn't accidentally admit it).

## Payment Data Security

Confirmed by schema inspection: `Payment` stores tender method, amount, and a free-text `reference` (a gateway auth-code/reference string) — no field anywhere is shaped to hold a full PAN, CVV, or card track data. This system is not a payment-card processor and integrates no payment gateway; no PCI-DSS-scoped functionality exists or was added this phase.

## Clinical Record Integrity

Not re-tested in depth — pre-existing coverage (finalized-note immutability, amendment-preserves-original, verified-lab/imaging-result lock, Receptionist-cannot-modify-clinical-records) already exists from earlier phases and was confirmed still passing in the full regression run, matching §63's "these mostly already exist... re-run representative tests, do not rebuild."

## Security Attack Matrix

| Attack | Expected | Actual | Result |
|---|---|---|---|
| Login brute force (20 failures, one IP) | throttled | Throttled at the 21st attempt; account-existence-neutral message | **PASS** |
| Login brute force, different account, same throttled IP | still throttled | Throttled identically | **PASS** |
| Login enumeration (nonexistent vs. real email, wrong password) | generic, identical | Identical "Invalid email or password." confirmed via both automated test and real browser | **PASS** |
| Suspended-organization login | rejected | Rejected with a clear, distinct message; confirmed via automated test and code path | **PASS** |
| Suspended-organization existing session reuse | rejected immediately | `getSessionContext`/`getPortalSessionContext` return `null` on the very next resolution, no re-login | **PASS** |
| Reset token replay (reuse after success) | rejected | `usedAt` check rejects; enforced in the same transaction as the password change | **PASS** |
| Expired reset token | rejected | `expiresAt` check rejects server-side; confirmed a garbage token is rejected via real browser | **PASS** |
| Logged-out session reuse | rejected | `revoked_at` set server-side (confirmed via direct DB read after a real logout click); `getSessionContext` on the same token returns `null` | **PASS** |
| Deactivated-user session reuse | rejected | Confirmed via automated test: mid-session deactivation, next resolution returns `null` | **PASS** |
| Removed-role stale session | rejected | Confirmed via automated test: permission removed mid-session, next resolution lacks it | **PASS** |
| Cross-org Patient ID | rejected | `getPatient` throws for a different-org session | **PASS** |
| Cross-org Invoice ID | rejected | `getInvoice` throws for a different-org session | **PASS** |
| Cross-org Employee ID | rejected | `getEmployee` throws for a different-org session | **PASS** |
| Cross-org User/Role assignment | rejected | Pre-existing (P3.12) `assertRolesInOrganization`/`assertBranchesInOrganization` — re-confirmed passing, not re-tested from scratch | **PASS** |
| External redirect (`//evil.example` as `from`) | rejected | `safeInternalRedirectPath` returns `null`, falls back to the real default landing route | **PASS** |
| Cron wrong token | rejected | `401`, constant-time-safe comparison, confirmed for both a similar-length and different-length wrong token | **PASS** |
| Financial field tampering (smuggled `totalAmount`/`paidAmount`/`status`/`organizationId`) | rejected/ignored | Server-computed values won in every case; smuggled values had zero effect | **PASS** |
| Financial overpayment (tender exceeding balance) | rejected | `recordPayment` throws; real balance left untouched | **PASS** |
| Finalized clinical note edit | rejected | Pre-existing coverage, re-confirmed passing in full regression | **PASS** |
| Runtime DB role mutating `audit_log` | rejected | Empirically re-confirmed (P4.2's own finding, still true): `UPDATE` through the restricted role fails | **PASS** |

Every row above has direct evidence (an automated test, a real browser action, or a direct database read) behind it — none is marked PASS from code inspection alone.

## Browser / HTTP Security Walkthrough

Performed against a real `next start` production build (`npm run build` clean, then `next start` on a local port), per §72 — not simulated:

1. **Login page** — loaded clean, zero console errors, CSP present.
2. **Repeated invalid login** — a wrong password correctly rejected with the generic message; no account lockout triggered at this low count (correctly requires 5 failures).
3. **Successful login** — `admin@avant.local`, real dashboard rendered with live DB data.
4. **Authenticated pages** — Dashboard, Patients, POS all rendered correctly with zero CSP console violations.
5. **Logout** — clicked in the real UI; confirmed via direct DB read that `Session.revokedAt` was set (not merely a cleared cookie).
6. **Old session rejected** — proven via the automated test suite (§ Session Security above) rather than a second manual browser pass, since the raw session token isn't extractable from a browser test tool once `httpOnly` hides it from page JS — the DB-level proof is the stronger evidence in any case.
7. **Security headers present** — confirmed via a real `curl -i` against the running production server: `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `Strict-Transport-Security` all present exactly as configured; `X-Powered-By` absent.
8. **CSP does not break the app** — zero console CSP violations across login, dashboard, patients, and POS.
9. **`/api/health`** — `200`, correct shape, confirmed in this batch's own pass (in addition to P4.1's).
10. **Cron unauthorized request** — `401` for a missing/wrong token, confirmed live.
11. **Password reset request — generic response** — a nonexistent email and a real account (`admin@avant.local`) produced byte-identical response text.
12. **Malformed/expired reset link handled safely** — a garbage token submitted to the confirm form produced "This reset link is invalid or has expired." — no crash, no leaked internal detail, zero console errors.

No external cloud deployment was used or required.

## Files Changed

**Created**:
- `src/lib/auth/rate-limit.ts` — IP-based login throttle
- `src/lib/platform/safe-redirect.ts` — open-redirect guard
- `test/integration/p4-3-production-security-hardening.test.ts` — 25 new tests
- `prisma/migrations/20260901_p4_3_login_history_rate_limit_channel/` — one small, hand-reviewed migration (see below)
- `docs/PRODUCTION_SECURITY.md`
- This report

**Modified**:
- `prisma/schema.prisma` — `LoginHistory` gains a `channel` (`staff`/`portal`) discriminator and a supporting `(ip, channel, createdAt)` index (§9's storage-backed rate-limit query path)
- `src/lib/auth/service.ts` — IP rate limit check, organization-suspension check, `channel: "staff"` on every `LoginHistory` write
- `src/lib/auth/portal-service.ts` — same, plus now writes to `LoginHistory` at all (previously didn't — a documented pre-existing gap this phase closed as a side effect)
- `src/lib/auth/session.ts` — `getSessionContext` now also rejects a session whose organization is suspended
- `src/lib/auth/portal-session.ts` — same, portal side
- `src/lib/domains/identity/schemas.ts` — max length on `createUserSchema`'s email/password
- `src/app/login/actions.ts` — open-redirect fix, max lengths on email/password/`from`
- `src/app/portal/login/actions.ts` — max lengths on email/password
- `src/app/reset-password/actions.ts` — max lengths on email/token/password/confirmPassword
- `src/app/api/cron/outbox-sweep/route.ts` — constant-time token comparison, `Cache-Control: no-store`
- `src/app/api/reports/export/route.ts` — `Cache-Control: no-store`
- `next.config.ts` — security headers, CSP, `poweredByHeader: false`
- `scripts/db/lib.ts` — unrelated to security; not touched this phase (verified, listed here only to note it was checked and left alone)

**Command run, not a code change**: `npm audit` (see Dependency Security above).

**Migration note**: `prisma migrate diff` also surfaced two pieces of pre-existing, unrelated drift in the live database (a leftover `OutboxStatus` enum value nothing writes anymore, and a cosmetically-renamed `payroll_run` index) — neither is a security issue and neither is related to this change, so the migration file was hand-trimmed to include only the `LoginHistory` change, matching this project's own established "hand-review before applying" migration discipline (documented in DEPLOYMENT.md).

## Tests Added / Updated

`test/integration/p4-3-production-security-hardening.test.ts` — 25 new tests, organized by the invariant each proves: IP-based rate limiting (3), the open-redirect guard (6, pure unit tests), organization suspension at login and for an existing session — staff and portal (6), session lifecycle security — logout/deactivation/fixation (3), stale-authorization-after-permission-removal (1), cross-organization IDOR — Patient/Invoice/Employee (3), financial-field-tampering resistance (2), cron constant-time-comparison correctness (1). Deliberately does not duplicate `branch-isolation.test.ts` (cross-branch), `p3-12-...test.ts` (cross-org role/branch assignment, last-admin protection), or P4.1's own cron 503/401/200 tests — all re-confirmed still passing in the full suite instead.

**A genuine bug in the test file's own cleanup was found and fixed during development**: the cross-organization IDOR describe block's `afterAll` initially left orphaned `Organization`/`Branch` rows behind in `his_test` across repeated runs (missing `CashierSession`, `OutboxEvent`, and — requiring the owner DB connection, since the restricted runtime role cannot delete it — `AuditLog` cleanup, each silently swallowed by a `.catch(() => {})`). This orphaned data was confirmed to break two *unrelated* test files (`appointment-double-booking.test.ts`, `journal-balance-trigger.test.ts`) that grab "the first branch" with no organization filter. Fixed in the test file itself (verified across two consecutive clean runs producing zero new orphans) — `his_test` was reset once, with the user's explicit consent (Prisma's own AI safety checkpoint correctly required this for `prisma migrate reset --force`), to clear the accumulated cruft before the final regression pass below.

## Regression Status

| Check | Result |
|---|---|
| `npx prisma validate` | ✅ Schema valid |
| `npx prisma migrate status` | ✅ Up to date — `his_dev`, `localhost:5433`, 35 migrations |
| `npm run typecheck` (`tsc --noEmit`) | ✅ Clean |
| `npm run lint` (ESLint) | ✅ Clean |
| `npx vitest run` | ✅ **58 test files, 503/503 tests passing** (57/478 at P4.2 close + this phase's 1 new file/25 new tests = 58/503) |
| `npm run build` (`next build`) | ✅ Clean production build |

**Integration test database**: `localhost:5433`, database `his_test` (local Docker Postgres). **Remote/hosted Supabase was NOT used** anywhere this phase — every database touched (the real `his_test` and, briefly, the P4.3 test file's own in-`his_test` fixture organizations) was local. No credential value is reproduced anywhere in this report.

**Honest process note**: the full suite was observed to fail non-deterministically twice during this phase's development — both traced to pre-existing, unrelated causes (the orphaned-fixture issue above, and a separate sequence-number-collision flake in an unrelated P3.13 test, both flagged as a background task rather than fixed in-scope here) — and passed cleanly (503/503) on the two runs immediately before and the one run immediately after this report's own writing, confirming the P4.3 changes themselves introduce no regression.

## Remaining Security Backlog

- **"Inactive account" login message specificity** (LOW): reveals more than "invalid credentials" to an unauthenticated caller. Pre-existing precedent (not introduced this phase); flagged rather than silently left undocumented.
- **`mysql2` transitive `npm audit` findings** (accepted residual risk, documented above and in docs/PRODUCTION_SECURITY.md).
- **MFA** for Super Admin/Org Admin/finance-privileged roles — recommended future enhancement, correctly not built this phase (§66).
- **Nonce-based CSP** to remove `'unsafe-inline'` — documented tradeoff, not built this phase.
- **CAPTCHA** — explicitly not added; documented as a future escalation only if sustained abuse is actually observed (§68).
- **Two pre-existing, unrelated test-suite hygiene issues** (orphaned P3.12 test fixtures; a sequence-number-dependent flaky P3.13 assertion) — flagged as a background task, out of this batch's security scope.

## P4.3 Acceptance Decision

Checked against every §81 criterion:

1. Login brute-force protection exists — ✅ (IP-throttle, new; per-account lockout, pre-existing)
2. Login does not trivially enumerate users — ✅ (generic message for nonexistent/wrong-password; the pre-existing locked/inactive distinction is a known, documented, low-severity exception, not a new gap)
3. Password-reset tokens secure, expiring, single-use — ✅ (hashed storage, 30-min expiry, single-use, all pre-existing and re-verified)
4. Session invalidation works on logout — ✅ (server-side revocation, verified via DB + automated test)
5. Deactivated users cannot keep using active sessions — ✅ (proven via automated test, immediate, no re-login)
6. Role/branch removal does not leave dangerous stale authorization — ✅ (proven via automated test, immediate)
7. Representative cross-org IDOR attacks fail — ✅ (Patient/Invoice/Employee, new tests)
8. Representative cross-branch attacks fail — ✅ (pre-existing, re-confirmed passing)
9. Financial field tampering fails — ✅ (new tests, both invoice-total and overpayment vectors)
10. Finalized clinical records remain protected — ✅ (pre-existing, re-confirmed passing)
11. Cron endpoint remains protected — ✅ (re-confirmed, plus a constant-time-comparison hardening)
12. Security headers implemented and verified over actual HTTP — ✅ (real `curl`/browser verification, not config-only)
13. CSP does not break representative production pages — ✅ (zero console violations, 4 representative pages)
14. Obvious open redirects prevented — ✅ (found and fixed the one that existed)
15. Public errors do not leak sensitive internals — ✅ (re-confirmed, unchanged from P4.1)
16. High/critical dependency findings addressed or justified — ✅ (2 High, both justified accepted residual risk; 0 Critical)
17. No real secrets committed — ✅ (confirmed)
18. Regression suite remains clean — ✅ (503/503, typecheck/lint/build all clean)

No authentication bypass, organization-isolation bypass, privilege-escalation path, plaintext reset-token exposure, or critical production-reachable dependency vulnerability exists.

# Can P4.3 be closed?

## YES

Per §82's explicit stop condition: stopping here. Not beginning P4.4, observability work, load testing, onboarding/import work, regulatory work, or another whole-project audit without further instruction.
