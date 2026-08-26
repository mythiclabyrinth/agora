import type { ThreadRow } from "../api/types";

export type ThreadSort = "recent" | "oldest" | "az" | "za";
export type ThreadFilter = "all" | "saved" | "unset";

function activityTs(thread: ThreadRow): number {
  return thread.last_reply_ts || thread.root.ts;
}

function alphabeticalKey(thread: ThreadRow): string {
  const alias = (thread.root.alias || "").trim();
  const name = alias || (thread.root.text || "").split("\n")[0].trim();
  return name.toLocaleLowerCase().slice(0, 10);
}

function compareAlphabetically(a: ThreadRow, b: ThreadRow, direction: 1 | -1): number {
  const aKey = alphabeticalKey(a);
  const bKey = alphabeticalKey(b);
  // Attachment-only roots without an alias stay below named rows in either direction.
  if (!aKey || !bKey) {
    if (!aKey && bKey) return 1;
    if (aKey && !bKey) return -1;
  }
  const byName = aKey.localeCompare(bKey, undefined, { sensitivity: "base", numeric: true });
  if (byName) return byName * direction;
  return activityTs(b) - activityTs(a) || a.root.id - b.root.id;
}

/** Filter and order the fetched Threads inbox without mutating its query-cache array. */
export function filterAndSortThreads(
  threads: ThreadRow[],
  sort: ThreadSort,
  filter: ThreadFilter,
): ThreadRow[] {
  const filtered = threads.filter((thread) => {
    const saved = !!thread.root.alias?.trim();
    return filter === "all" || (filter === "saved" ? saved : !saved);
  });
  // The server and WS reducer already maintain recent order; preserve it exactly.
  if (sort === "recent") return filtered;
  return [...filtered].sort((a, b) => {
    if (sort === "oldest") return activityTs(a) - activityTs(b) || a.root.id - b.root.id;
    return compareAlphabetically(a, b, sort === "az" ? 1 : -1);
  });
}
