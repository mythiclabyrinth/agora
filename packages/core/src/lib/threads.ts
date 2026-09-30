import type { Group, ThreadRow } from "../api/types";
import { validLastReplyTs } from "./format";

export type ThreadSort = "recent" | "oldest" | "az" | "za";
export type ThreadFilter = "all" | "saved" | "unset";

/** Groups represented in the inbox, ordered like the sidebar when available. */
export function threadGroupOptions(threads: ThreadRow[], groups: Pick<Group, "id" | "name">[] = []): { id: string; name: string }[] {
  const names = new Map<string, string>();
  for (const thread of threads) {
    if (thread.group_id && !names.has(thread.group_id)) names.set(thread.group_id, thread.group_name);
  }
  const order = new Map(groups.map((group, index) => [group.id, index]));
  return [...names].map(([id, name]) => ({ id, name: groups.find(group => group.id === id)?.name ?? name }))
    .sort((a, b) => {
      const aOrder = order.get(a.id) ?? Infinity;
      const bOrder = order.get(b.id) ?? Infinity;
      return aOrder - bOrder || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);
    });
}

export function threadActivityTs(thread: ThreadRow): number {
  return validLastReplyTs(thread.last_reply_ts) ? thread.last_reply_ts : thread.root.ts;
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
  return threadActivityTs(b) - threadActivityTs(a) || a.root.id - b.root.id;
}

/** Filter and order the fetched Threads inbox without mutating its query-cache array. */
export function filterAndSortThreads(
  threads: ThreadRow[],
  sort: ThreadSort,
  filter: ThreadFilter,
  groupId: string | null = null,
): ThreadRow[] {
  const filtered = threads.filter((thread) => {
    const saved = !!thread.root.alias?.trim();
    return (groupId === null || thread.group_id === groupId)
      && (filter === "all" || (filter === "saved" ? saved : !saved));
  });
  // The server and WS reducer already maintain recent order; preserve it exactly.
  if (sort === "recent") return filtered;
  return [...filtered].sort((a, b) => {
    if (sort === "oldest") return threadActivityTs(a) - threadActivityTs(b) || a.root.id - b.root.id;
    return compareAlphabetically(a, b, sort === "az" ? 1 : -1);
  });
}
