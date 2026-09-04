import "server-only"
import { z } from "zod"

/**
 * P4.1 §7: centralized, fail-fast environment validation — wired into
 * `src/instrumentation.ts`'s `register()` so a misconfigured production
 * deployment refuses to serve traffic with a clear error naming exactly
 * which variable is missing/invalid, rather than surfacing as a confusing
 * downstream failure (a Prisma connection error with no context, a silent
 * relative-path link in a real email, ...) the first time a request
 * happens to touch the missing config.
 *
 * Scoped to what the RUNNING APPLICATION actually reads at request time —
 * `DIRECT_DATABASE_URL` is deliberately excluded: it's a Prisma-CLI-only
 * concern (`prisma.config.ts`, `migrate deploy`/`db seed`), never read by
 * the app itself, and already fails loudly on its own the moment a CLI
 * command that needs it runs. Duplicating that check here would validate a
 * variable this process never touches.
 *
 * This file previously existed but was never imported anywhere in the
 * codebase — `loadEnv()` never actually ran, so it provided zero real
 * protection despite looking like a boot-time guard. It also required a
 * `SESSION_SECRET` that no code path reads (session/reset tokens are raw
 * `crypto.randomBytes` values, hashed before storage — see
 * `src/lib/auth/tokens.ts` — their own randomness is what makes them
 * unguessable, not an HMAC secret) and a `STORAGE_DRIVER` for a file-
 * storage abstraction that doesn't exist in this codebase (every document-
 * adjacent model stays metadata-only — see DEPLOYMENT.md's Environments
 * section). Both were dropped rather than carried forward as dead
 * validation requirements.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required — the runtime database connection (src/lib/db.ts)."),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  // Optional: /api/cron/outbox-sweep refuses every request (503) rather than
  // running unauthenticated when this is unset — a missing value is a valid,
  // safe (if degraded) state, not a startup failure. See that route and
  // DEPLOYMENT.md's "Outbox Sweep Scheduling".
  CRON_SECRET: z.string().min(1).optional(),
  // Optional: how long (ms) an outbox event may sit in "processing" before
  // it's presumed crashed — see src/lib/platform/outbox.ts. Sensible
  // default applies if unset.
  OUTBOX_PROCESSING_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  // Optional but recommended in any deployed environment: the scheme+host a
  // real user's browser/email client can reach this deployment at (e.g.
  // "https://app.example.com"). Nothing in local development needs it —
  // every link this app generates today is a relative path, safe inside a
  // browser tab already on the site — but a real email/SMS provider
  // (§17) needs an ABSOLUTE link, which is impossible to construct
  // correctly without knowing the deployment's own public origin. See
  // requestPasswordReset (src/lib/auth/service.ts) for the one place this
  // is used today.
  APP_BASE_URL: z.string().url("APP_BASE_URL must be a full URL, e.g. https://app.example.com").optional(),
  // P4.8 §8/§39: optional release identifier — see src/lib/platform/release.ts
  // for the full resolution order. Never required: Vercel already sets
  // VERCEL_GIT_COMMIT_SHA automatically, and any environment sets neither
  // still falls back to package.json's own version, never a boot failure.
  RELEASE_VERSION: z.string().min(1).optional(),
})

export type Env = z.infer<typeof envSchema>

/**
 * Validates `process.env` against the schema above. Called once from
 * `instrumentation.ts`'s `register()` (real server boot only — never during
 * `next build`, and never during the vitest integration suite, which
 * doesn't invoke Next's instrumentation hook at all) so a misconfigured
 * deployment fails immediately and loudly, before serving a single request,
 * rather than surfacing as a confusing runtime error later. Never logs
 * actual variable values — only which names are missing/invalid, matching
 * §7's "no secrets logged."
 */
export function validateEnv(): Env {
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors
    const missing = Object.keys(fieldErrors)
    console.error(`Invalid environment configuration — problem with: ${missing.join(", ")}`)
    for (const [key, messages] of Object.entries(fieldErrors)) {
      console.error(`  ${key}: ${(messages ?? []).join("; ")}`)
    }
    throw new Error(`Invalid environment configuration — see the field errors logged above (${missing.join(", ")}).`)
  }
  return parsed.data
}
