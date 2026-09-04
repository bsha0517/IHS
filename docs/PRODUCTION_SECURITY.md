# Production Security

Written in P4.3 (Production Security Hardening). Concise and operational — for the full attack-surface trace, findings, and evidence behind every claim here, see [P4_3_PRODUCTION_SECURITY_HARDENING_REPORT.md](../P4_3_PRODUCTION_SECURITY_HARDENING_REPORT.md). This document makes no regulatory-certification claim of any kind.

## Security Architecture

Defense in depth, no layer trusts the layer above it:

1. **`src/proxy.ts`** — the first, cheap check: does a request to a non-public path carry a valid, unexpired, unrevoked session? Runs in the Node.js runtime (Next 16's default for Proxy), DB-backed.
2. **Dashboard layout** — re-checks session validity (defense in depth, cheap indexed lookup).
3. **Every Server Action / Route Handler** — authenticates (`getCurrentSession()`), then explicitly authorizes (`assertCan(session, "permission.code", {...})`) before doing anything.
4. **Every domain function** — re-derives its own authorization (`assertCan`, `assertBranchAccess`) rather than trusting its caller already checked; every read/write is scoped by `organizationId`/`branchId` derived from the session, never from client input.
5. **PostgreSQL** — the application's own runtime connection is the restricted `avant_app_runtime` role (`his_app_runtime` locally), never the schema owner; `audit_log`/`clinical_access_log` are genuinely insert-only for it (UPDATE/DELETE revoked at the database level, empirically verified — see P4.2's drill).

## Authentication

Login path: form → Server Action (`src/app/login/actions.ts`) → `login()` (`src/lib/auth/service.ts`) → credential lookup → password verification → session creation → cookie → redirect. Every attempt (success or failure) is written to `LoginHistory`, including a `channel` (`staff`/`portal`) added in P4.3.

- **Generic failure response**: "Invalid email or password." for a nonexistent user, a wrong password, or (existing precedent, not changed this phase) a distinct message for a locked/inactive account or a suspended organization — see §"Login User Enumeration" in the report for the precise, deliberate boundary of what this codebase already chooses to reveal vs. not.
- **Organization status** (new in P4.3): a suspended organization (`Organization.status`) now blocks both a fresh login and an already-issued session on its very next resolution — previously unenforced anywhere despite the schema field existing.
- **Inactive-user / deactivated-user handling**: `getSessionContext` re-derives from live DB state on every request (no cached/embedded session data beyond the opaque token) — deactivating a user takes effect immediately, no re-login required.

## Password Policy

- **Hashing**: Argon2id (`argon2` package's own default parameters — this codebase does not override memory/time/parallelism cost). Already adequate; left unchanged (§6 — "if existing implementation is adequate, leave it alone").
- **Staff-created accounts** (admin `createUser`): minimum 10 characters.
- **Self-service reset**: minimum 8 characters.
- Both now carry a 256-character maximum (new in P4.3) — a resource-abuse bound, not a policy tightening; no real password/passphrase is anywhere near that length.
- No forced periodic password rotation, no arbitrary complexity circus (no mandatory symbol/digit mix) — a passphrase is a valid password.
- No country-specific policy.

## Brute-Force Protection

Two independent layers:

1. **Per-account lockout** (pre-existing, unchanged): 5 failed attempts locks the account for 15 minutes — temporary, not indefinite, so it can't itself become a denial-of-service tool against a known account.
2. **Per-IP throttle** (new in P4.3, `src/lib/auth/rate-limit.ts`): 20 failed attempts from one IP within a 10-minute sliding window throttles further attempts from that IP, regardless of which account is being tried — closes the "guess across many different accounts from one IP" gap the per-account lockout alone can't see. Storage-backed (`LoginHistory`, via a plain indexed count query), not process-memory, so it behaves correctly across multiple/serverless application instances. Applies identically to staff and portal login. No CAPTCHA; none added — rate limiting is the first-line control, CAPTCHA is documented below as a future escalation only if sustained abuse is observed in practice.

## Password Reset

Trace: request → `requestPasswordReset()` generates a raw token (`crypto.randomBytes(32)`, base64url) → only its SHA-256 hash is stored (`PasswordResetToken.tokenHash`) → an email is attempted via the honest `NullEmailAdapter` (reports `delivered: false` — no live provider is configured in this environment; see [PRODUCTION_DEPLOYMENT.md](PRODUCTION_DEPLOYMENT.md)) → the UI shows one generic message regardless of whether the account exists → `confirmPasswordReset()` validates the token's hash, checks `expiresAt` server-side and `usedAt` (single-use) before allowing the new password → the token row is marked used in the same transaction as the password change → **every existing session for that user is immediately revoked** (`revokeAllUserSessions`) — a stolen active session cannot survive the legitimate owner regaining control.

- Token entropy: 256 bits.
- Never logged, never returned to the client beyond the one email/link it's meant for.
- Expired or already-used tokens fail server-side with the same generic message, even if the UI link is still reachable — verified against a real production build (see the report's Browser/HTTP Walkthrough).

## Sessions

`Session`/`PatientPortalSession` — 256-bit random token (`crypto.randomBytes(32)`), only its SHA-256 hash persisted (a DB leak alone never yields a usable token), 12-hour expiry, `httpOnly`/`secure`-in-production/`sameSite: lax`/`path: /` cookie. Every request re-resolves the full session from live DB state (user status, organization status, roles, permissions, branch access) — nothing is cached or embedded in the cookie beyond the opaque token itself, which is what makes deactivation/role-change/org-suspension take effect immediately rather than only at next login.

- **Session fixation**: a fresh session (new random token) is issued on every successful authentication; an unauthenticated visitor holds no prior session identifier that gets "upgraded."
- **Logout**: server-side revocation (`revokedAt` set), not merely cookie deletion — verified both via direct browser walkthrough (DB row inspected after clicking Log out) and an automated test asserting the raw token can no longer resolve a session afterward.
- **Expiration**: enforced server-side (`expiresAt` compared against `Date.now()` on every resolution) — a lingering browser cookie past that point resolves to nothing.

## Authorization / RBAC

Single chokepoint: `can()`/`assertCan()` (`src/lib/platform/permissions-core.ts`). Super Admin bypasses the permission-code check but remains subject to branch scoping. Every permission decision funnels through here — auditable in one place.

**Stale authorization**: because `getSessionContext` re-derives permissions/roles from the database on every request (never caches them across requests), removing a permission from a role takes effect on the very next request against an *already-issued* session — no re-login required. Verified directly (automated test: grant a permission, resolve a session, revoke the permission via `updateRolePermissions`, re-resolve the *same* session token, confirm the permission is gone).

## Organization Isolation

Every domain read/write derives `organizationId` from the session, never from client input (a long-standing, consistently-applied pattern — confirmed by tracing representative write paths: `createUser` explicitly comments on this). New this phase: a representative cross-organization IDOR test suite (`Patient`, `Invoice`, `Employee`) proves a session from Organization B cannot read an Organization A record by ID. Cross-org role/branch *assignment* protection (`assertRolesInOrganization`/`assertBranchesInOrganization`) predates this phase (P3.12) and was re-verified, not rebuilt.

## Branch Isolation

Pre-existing, extensively tested (`test/integration/branch-isolation.test.ts`, P0-01) — a branch-scoped session cannot read another branch's patients, appointments, invoices, clinical orders, inventory, or accounting via either the list path (filtered out) or the direct-by-id path (throws). Not re-audited this phase per its own explicit "already passed" status; representative new coverage this phase focused on the cross-*organization* dimension instead (a gap that had no prior dedicated test).

## CSRF / Request Origin

- **Server Actions**: Next.js's own built-in Origin-header verification for the Server Actions RPC mechanism (compares `Origin` against the deployment's own host, rejecting a cross-origin POST) applies automatically — no `serverActions.allowedOrigins` override is configured, so the default same-origin-only behavior is in effect. No duplicate CSRF-token framework was built on top of it.
- **Cookie-authenticated API routes** (`/api/reports/export`, a GET, and `/api/cron/outbox-sweep`, bearer-token-protected, not cookie-authenticated at all): this codebase has no cookie-authenticated *mutating* (POST/PUT/PATCH/DELETE) API route today — every state-changing write goes through a Server Action, which already has the origin protection above. Documented rather than inventing middleware for a surface that doesn't exist (§24's own instruction).
- The session cookie's own `sameSite: "lax"` is a second, independent layer: a cross-site POST from another origin does not include a Lax cookie at all, regardless of the Server Action origin check.

## Security Headers / CSP

Set globally via `next.config.ts`'s `headers()` (verified against real HTTP responses from a `next start` production build, not just configuration inspection):

| Header | Value |
|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` (redundant with CSP `frame-ancestors 'none'`, kept for older-browser defense-in-depth) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=()` |
| `Strict-Transport-Security` | `max-age=15552000` (production only) |

**CSP known limitation, documented deliberately (not an oversight)**: `script-src`/`style-src` include `'unsafe-inline'`. Next.js's App Router injects its own inline RSC-streaming bootstrap script on every page; blocking it without `'unsafe-inline'` requires a per-request nonce generated in `src/proxy.ts` and threaded through every script tag — a real, working pattern, but a larger architectural change than this batch makes. Verified via a real browser walkthrough (login, dashboard, patients, POS) that the current policy breaks nothing in this application; console showed zero CSP violations on any page tested.

**HSTS**: `includeSubDomains` deliberately NOT set — it would force HTTPS on every subdomain of the production domain, including ones this deployment may not control. `preload` is never set (a slow-to-reverse browser-list submission). Both are documented here as the specific, considered reason, not silently omitted.

**No external script/style/font/image host is allowlisted** — fonts are self-hosted via `next/font/google` (downloaded at build time, served from the app's own origin; confirmed no runtime request to Google's font CDN), and no remote `next/image` domain is configured anywhere.

## Input Validation

Every Server Action validates its input with Zod before calling a domain function — TypeScript types are never trusted as runtime validation. New in P4.3: explicit maximum lengths added to login/portal-login/reset-password/admin-user-creation email and password fields (an unauthenticated endpoint accepting an unbounded string is a resource-abuse surface, independent of the field's own format validity) and to the reset-token/redirect-path fields.

**Open redirect** (fixed in P4.3): the staff login page's post-login `from` redirect previously accepted anything starting with `/`, which a protocol-relative URL (`//evil.example`) also satisfies while a browser resolves it off-site. `src/lib/platform/safe-redirect.ts`'s `safeInternalRedirectPath()` now rejects protocol-relative and backslash-leading values in addition to full external URLs — unit-tested directly. Portal login's post-login redirect was already a hardcoded internal path (`/portal`), never client-controlled — no fix needed there.

## Sensitive Data / Logging

`src/lib/platform/logger.ts`'s documented never-log list (unchanged, re-verified this phase): passwords, password hashes, reset tokens, session tokens, DB connection strings, full clinical note content, more patient detail than an `entityId`, card data. The typed field shape (`event`, `domain`, `operation`, `correlationId`, `organizationId`/`branchId`/`userId`/`entityId`, a short `reference` label) is deliberately narrow rather than a free-text `context: Record<string, unknown>` blob, specifically to make it harder to accidentally log something that shouldn't be. Login-failure logging (`LoginHistory`) records a safe internal `reason` classification (`bad_password`, `locked`, `ip_throttled`, `organization_suspended`, ...) — never the attempted password.

**Cache-Control** (new in P4.3): `no-store` added to the CSV report-export response and the cron sweep's JSON response — neither should ever be cached by a shared/public cache.

## Audit / Clinical Access Logging

Kept distinct, as designed: operational logs (`logger.ts`, troubleshooting) vs. `AuditLog` (business/security-sensitive user actions — login, password reset, user/role changes, refund authorization, manual journal posting, ...; written by `auditFromSession`, called from the data-access layer of every domain service that mutates an audited entity) vs. `ClinicalAccessLog` (sensitive clinical record access). Both audit tables are genuinely insert-only for the application's runtime database role — UPDATE/DELETE are revoked at the PostgreSQL level (P0-06), empirically re-confirmed after a real restore in P4.2's drill, and re-confirmed *again* in P4.3 (an attempted `UPDATE audit_log` through the restricted role is rejected — see the report's Attack Matrix).

## Dependency Security

`npm audit`: 2 High findings, both the same underlying issue (`mysql2` auth-plugin-downgrade credential disclosure, CWE-522), reached only through `prisma` (the CLI, a devDependency). This project's `datasource` is PostgreSQL-only — `mysql2`'s vulnerable MySQL-auth-negotiation code path is never exercised, since no MySQL connection is ever made, in development or production. The available "fix" is a Prisma major-version change that this project's own instructions explicitly say not to force merely to zero out audit output. **Accepted residual risk**: transitive, dev-only, unreachable code path. No Critical findings. No production-reachable High/Critical finding exists.

## Secrets

Unchanged from P4.1 (not re-documented in full here — see [PRODUCTION_DEPLOYMENT.md §2](PRODUCTION_DEPLOYMENT.md#2-environment-variables) and §17). `.env` is git-ignored; `.env.example` holds placeholders only; no secret value appears in this document, the P4.3 report, or any file this phase touched. A repository scan for obvious committed credentials (passwords, tokens, connection strings, private keys) in currently-tracked files found none.

## Infrastructure Endpoints

- **`/api/health`**: no session/auth required (a probe never carries one); returns only `{status, database, timestamp, version, durationMs}` — no host, database name, connection string, or stack trace, verified by direct inspection of the response body and by the P4.1 test asserting the serialized response never matches a `postgres(ql)?://` pattern.
- **`/api/cron/outbox-sweep`**: bearer-token-protected (`CRON_SECRET`); 503 if unset, 401 if mismatched, 200 with the sweep result if correct. New in P4.3: the token comparison now uses `crypto.timingSafeEqual` (a length check short-circuits first, so this doesn't reintroduce a leak through length) instead of a plain `!==` string comparison — a low-severity-in-practice but free, standard fix. The success response never echoes back event payloads or the submitted token, and now carries `Cache-Control: no-store`.
- **GET must not mutate**: the cron endpoint is the one deliberate exception — a special infrastructure endpoint, already protected by a shared secret, not a normal user-facing GET. No other GET route in this codebase performs a state-changing operation.

## Payment Data Security

This system records payment *tenders* (method, amount, reference, e.g. an authorization code) — never a full card PAN, CVV, or track data anywhere in the schema (confirmed: `Payment.reference` is a free-text field for a gateway's own reference/auth-code string, not raw card data; no field anywhere is shaped to hold one). This is not a payment-card processor and does not integrate a payment gateway — no PCI-DSS-scoped functionality exists or was added.

## Known Security Limitations

- CSP relies on `'unsafe-inline'` for scripts/styles rather than a nonce — documented above, not silently accepted.
- No MFA anywhere in the product (Super Admin, Org Admin, or any other role) — see Future Security Enhancements.
- No CAPTCHA/challenge mechanism — rate limiting is the current, sole automated-abuse control.
- Portal accounts have no separate per-IP-and-per-account distinction beyond what this phase added (mirrors staff exactly as of this phase, previously had no `LoginHistory` coverage at all).
- The pre-existing "inactive account" login message is more specific than "Invalid email or password" (reveals the account exists but is inactive) — a deliberate precedent set before this phase (the "locked" message has the same property, justified in the code's own comment: the attacker already knows the account exists if they caused the lock). Not redesigned this phase (§8 asks to avoid *introducing* enumeration, not to retroactively re-architect an existing, working, if imperfect, precedent) — flagged here as a real, low-severity, MEDIUM-backlog item rather than left undocumented.
- Two pre-existing, unrelated test-suite hygiene issues were discovered while running the full regression (orphaned test-fixture organizations from an older test file, and a sequence-number-dependent flaky assertion in another) — flagged as a background task for follow-up, not a security issue and not fixed in this phase (out of scope; see the report's Remaining Security Backlog).

## Future Security Enhancements

Recommended, not built this phase, and not required for an initial commercial V1 per this batch's own scope:

- **MFA** for Super Admin, Organization Administrator, and finance/admin-privileged roles — the highest-value addition once the product has real paying customers with real financial/clinical data at stake.
- **Nonce-based CSP** to drop `'unsafe-inline'` from `script-src`/`style-src` entirely.
- **CAPTCHA/challenge** as an escalation if sustained automated login abuse is observed in production (not preemptively).
- **A hosting-provider WAF** (e.g. Vercel's or Cloudflare's) as defense-in-depth — application security must never depend on it existing, but it's a reasonable additional layer once in production.
- **SSO/SAML/SCIM** — explicitly out of scope, a future enterprise feature.
- Retroactively tightening the "inactive account" login message's enumeration exposure (see Known Security Limitations above).
