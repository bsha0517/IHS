import Link from "next/link"
import { Button } from "@/components/ui/button"

/**
 * P2 §8: the one Prev/Next control every paginated list page in this batch
 * uses — same shape `admin/audit` (pre-existing) already established,
 * pulled out here so it's not re-implemented slightly differently on each
 * of the ~10 pages this batch touches. A server component (no client JS
 * needed for page links) — preserves every other filter already in the
 * URL by copying `searchParams` verbatim and only overwriting `page`.
 */
export function PaginationControls({
  page,
  totalPages,
  total,
  basePath,
  searchParams,
  pageParam = "page",
}: {
  page: number
  totalPages: number
  total: number
  basePath: string
  searchParams: Record<string, string | undefined>
  /** P3.8 §28/§30/§46: lets two independently-paginated lists share one page (e.g. Inventory's Ledger and Transfers tabs) without their page numbers colliding in the URL. Defaults to "page", the convention every other caller already uses. */
  pageParam?: string
}) {
  if (totalPages <= 1) return null

  const hrefFor = (targetPage: number) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(searchParams)) {
      if (value && key !== pageParam) params.set(key, value)
    }
    params.set(pageParam, String(targetPage))
    return `${basePath}?${params.toString()}`
  }

  return (
    <div className="mt-4 flex items-center justify-end gap-2">
      <span className="text-sm text-muted-foreground">{total} total</span>
      <Button variant="outline" size="sm" disabled={page <= 1} asChild={page > 1}>
        {page > 1 ? <Link href={hrefFor(page - 1)}>Previous</Link> : <span>Previous</span>}
      </Button>
      <span className="text-sm text-muted-foreground">
        Page {page} of {totalPages}
      </span>
      <Button variant="outline" size="sm" disabled={page >= totalPages} asChild={page < totalPages}>
        {page < totalPages ? <Link href={hrefFor(page + 1)}>Next</Link> : <span>Next</span>}
      </Button>
    </div>
  )
}
