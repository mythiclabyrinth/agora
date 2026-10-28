/** Appends a page, dropping rows already listed: offset paging over a live,
    activity-ordered list can repeat a row that moved between requests, and
    a repeated id would also collide as a React key. */
export function appendUnique<T extends { id: string | number }>(rows: T[], page: T[]): T[] {
  const seen = new Set(rows.map(r => r.id));
  const fresh: T[] = [];
  for (const row of page) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    fresh.push(row);
  }
  return [...rows, ...fresh];
}

/** Whether to offer another "More results" after a page arrived. A short
    page (fewer rows than asked for), a page of only repeats, or the
    server's own `hasMore: false` ends the list, even when an earlier total
    promised more: rows can vanish between requests, and trusting the total
    would offer More forever. */
export function moreAfterPage(page: { rows: number; fresh: number; limit: number; hasMore?: boolean }): boolean {
  if (page.hasMore === false) return false;
  return page.rows >= page.limit && page.fresh > 0;
}
