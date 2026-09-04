/**
 * P4.3 §44: the one place a client-controlled "where to go after login"
 * value is validated before being handed to `redirect()`. Only a genuine,
 * same-origin internal path is ever accepted — never a full URL, and
 * critically never a *protocol-relative* one: `"//evil.example"` passes a
 * naive `.startsWith("/")` check (it does start with one slash) but a
 * browser resolves it as `https://evil.example` — the exact open-redirect
 * this function exists to close. `"/\\evil.example"` is rejected for the
 * same reason: some browsers normalize a leading backslash to a second
 * forward slash before resolving the URL, so it's an equivalent bypass
 * attempt, not a legitimate internal path.
 *
 * No allowlisted external origin is supported — this app has no legitimate
 * use case for redirecting off-site after login, so "safe internal path
 * only" is the complete rule, not a simplification of a richer one.
 */
export function safeInternalRedirectPath(candidate: string | null | undefined): string | null {
  if (!candidate) return null
  if (!candidate.startsWith("/")) return null
  if (candidate.startsWith("//")) return null
  if (candidate.startsWith("/\\")) return null
  // A same-origin relative path never legitimately contains "://" — its
  // presence means something is trying to smuggle a scheme past the checks
  // above (e.g. "/redirect?url=https://evil.example" style values would
  // still fail the leading-slash checks, but this is a deliberate second,
  // independent guard rather than relying on the first two alone).
  if (candidate.includes("://")) return null
  return candidate
}
