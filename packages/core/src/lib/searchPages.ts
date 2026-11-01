/* Search result paging and labels shared by the web and mobile search
   screens: both cap the overview the same way and page "See all" lists
   with the same stop rules. */

import type { SearchKind } from "../api/queries";

/** Rows per kind in the overview, so every section keeps a fixed height and
    one busy kind can't push the others out of view. */
export const OVERVIEW_ROWS = 4;

/** The server counts message hits to one past this, then stops. */
export const SEARCH_TOTAL_CAP = 1000;

/** Only message totals stop at the server's cap (counting one past it, so
    exactly 1,000 still reads "1,000"); other kinds are exact. */
export function searchCountLabel(kind: SearchKind, n: number): string {
  return kind === "messages" && n > SEARCH_TOTAL_CAP ? `${SEARCH_TOTAL_CAP.toLocaleString()}+` : n.toLocaleString();
}

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
