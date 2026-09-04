import path from "node:path";
import type { NextConfig } from "next";

/**
 * P4.3 §37-42: production security headers, verified against a real
 * `next start` build (see P4_3_PRODUCTION_SECURITY_HARDENING_REPORT.md's
 * Browser / HTTP Security Walkthrough) — this is `next.config.ts`'s own
 * documented mechanism for setting headers on every response, applying
 * before any page/route handler runs.
 *
 * CSP notes:
 * - `script-src`/`style-src` include `'unsafe-inline'`. This is a
 *   deliberate, documented compromise, not an oversight: Next.js's App
 *   Router injects its own inline bootstrap script (the RSC streaming
 *   payload, `self.__next_f.push(...)`) on every page, which a strict CSP
 *   without `'unsafe-inline'` would block unless a per-request nonce is
 *   generated (in `src/proxy.ts`) and threaded through every `<Script>`
 *   tag — real, working, but a larger architectural change than this batch
 *   makes. Documented as a remaining-hardening item in
 *   docs/PRODUCTION_SECURITY.md rather than silently accepted.
 * - No external script/style/font/image host is allowlisted: fonts are
 *   self-hosted via `next/font/google` (downloaded at build time, served
 *   from this app's own origin — confirmed no runtime request to
 *   fonts.googleapis.com/fonts.gstatic.com), and no CDN/remote-image
 *   `next/image` domain is configured anywhere in this app.
 * - `frame-ancestors 'none'` — this app has no legitimate embedding use
 *   case (§40).
 */
const isProd = process.env.NODE_ENV === "production";

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Belt-and-suspenders with CSP's own frame-ancestors above — redundant on
  // a modern browser, harmless, and covers the rare older one that only
  // understands X-Frame-Options.
  { key: "X-Frame-Options", value: "DENY" },
  // Avoids leaking a full internal path (which, per §43, matters
  // specifically once reset-token/clinical-identifier query strings exist
  // in a URL) to an external origin via the Referer header on outbound
  // navigation/subresource requests, while still sending it for same-origin
  // navigation (useful for this app's own analytics/debugging, if any is
  // ever added).
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // This app never uses the camera, microphone, geolocation, or payment
  // APIs — explicitly denies them (and disables them for any embedded
  // frame, though frame-ancestors above already prevents embedding this
  // app at all).
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

// §39: HSTS only in a real production HTTPS deployment — it has no
// meaningful effect over local http:// dev anyway (browsers ignore it on a
// non-HTTPS response), but this still gates it explicitly rather than
// relying on that alone. `includeSubDomains` is deliberately NOT set: it
// would also force HTTPS on every subdomain of the production domain,
// including ones this app doesn't control or know about — see
// docs/PRODUCTION_SECURITY.md for the tradeoff and when it's safe to add.
// `preload` is never set casually per §39's own instruction — submitting to
// a browser's HSTS preload list is a slow-to-reverse commitment this batch
// does not make unilaterally.
if (isProd) {
  securityHeaders.push({ key: "Strict-Transport-Security", value: "max-age=15552000" });
}

const nextConfig: NextConfig = {
  // Pins the workspace root explicitly — without this, Turbopack's lockfile
  // auto-detection walks up to a lockfile in the user's home directory and
  // warns/misbehaves about it.
  turbopack: {
    root: path.join(__dirname),
  },
  // Trivial, zero-risk hardening: don't advertise the framework via an
  // `X-Powered-By: Next.js` response header.
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
