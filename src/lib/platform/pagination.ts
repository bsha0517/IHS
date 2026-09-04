/**
 * P2 §8: the one shared convention every paginated list function in this
 * batch uses — `page`/`pageSize`/`totalCount`/`totalPages`, computed the
 * same way everywhere rather than each list re-deriving its own skip/take
 * math and its own totalPages rounding. Pre-existing paginated lists
 * (`listAuditLog`, `listClinicalAccessLog`, `listPatients`, System Events)
 * already used this exact shape informally; this just gives it one home so
 * every list added or fixed this batch matches them exactly, not a
 * slightly-different convention next to theirs.
 */
export function resolvePage(rawPage: number | string | undefined): number {
  const n = typeof rawPage === "string" ? Number(rawPage) : rawPage
  return Math.max(1, Number.isFinite(n) && n ? Math.floor(n as number) : 1)
}

export function paginationSkipTake(page: number, pageSize: number): { skip: number; take: number } {
  return { skip: (page - 1) * pageSize, take: pageSize }
}

export function totalPages(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize))
}
