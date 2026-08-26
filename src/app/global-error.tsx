"use client"

import { useEffect } from "react"

/**
 * Catches an error thrown by the root layout itself (distinct from
 * (dashboard)/error.tsx, which only catches errors in pages rendered inside
 * the dashboard layout). Must render its own <html>/<body> — it replaces the
 * root layout entirely when active — and deliberately avoids depending on
 * Tailwind/shadcn/fonts loading correctly, since a root-layout failure could
 * mean any of those are the reason it's rendering at all.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", background: "#f8f8f8" }}>
        <div style={{ maxWidth: 420, padding: 24, textAlign: "center" }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Something went wrong</h1>
          <p style={{ color: "#666", marginBottom: 16 }}>
            The application failed to load. This has been logged.
            {error.digest && <span style={{ display: "block", fontFamily: "monospace", fontSize: 12, marginTop: 4 }}>Reference: {error.digest}</span>}
          </p>
          <button
            onClick={reset}
            style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid #ccc", background: "#fff", cursor: "pointer" }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  )
}
