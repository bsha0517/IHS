import { NAV_GROUPS } from "@/components/layout/nav-config"
import { ComingSoon } from "@/components/layout/coming-soon"

// Catch-all for nav destinations whose module hasn't landed yet (Phases 3+).
// Explicit routes (e.g. /admin/settings, /patients) always take precedence over
// this in Next.js route resolution, so this only ever renders for the not-yet-built
// modules — the sidebar (built from the same NAV_GROUPS list) never links to a
// dead 404.
export default async function ComingSoonRoute({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params
  const href = `/${slug.join("/")}`
  const label = NAV_GROUPS.flatMap((g) => g.items).find((item) => item.href === href)?.label ?? href

  return <ComingSoon label={label} />
}
