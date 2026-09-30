import type { Group, ThreadRow } from "../api/types";
import { validLastReplyTs } from "./format";

export type ThreadSort = "recent" | "oldest" | "az" | "za";
export type ThreadFilter = "all" | "saved" | "unset";

/** Groups represented in the inbox, plus the selected group, in sidebar order when available. */
export function threadGroupOptions(
  threads: ThreadRow[],
  groups: Pick<Group, "id" | "name">[] = [],
  selectedGroupId: string | null = null,
): { id: string; name: string }[] {
  const groupInfo = new Map(groups.map((group, index) => [group.id, { index, name: group.name }]));
  const names = new Map<string, string>();
  for (const thread of threads) {
    if (thread.group_id && !names.has(thread.group_id)) {
      names.set(thread.group_id, thread.group_name?.trim() || "Unknown group");
    } else if (thread.group_id && names.get(thread.group_id) === "Unknown group" && thread.group_name?.trim()) {
      names.set(thread.group_id, thread.group_name.trim());
    }
  }
  if (selectedGroupId && !names.has(selectedGroupId)) {
    names.set(selectedGroupId, groupInfo.has(selectedGroupId) ? "Unknown group" : "Loading…");
  }
  return [...names].map(([id, name]) => ({ id, name: groupInfo.get(id)?.name?.trim() || name }))
    .sort((a, b) => {
      const aOrder = groupInfo.get(a.id)?.index ?? Infinity;
      const bOrder = groupInfo.get(b.id)?.index ?? Infinity;
      return aOrder - bOrder || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);
    });
}

/** A capped thread list cannot prove that a selected group has been removed. */
export function resolveThreadGroupSelection({ threads, groups, groupsLoaded, selectedGroupId }: {
  threads: ThreadRow[];
  groups: Pick<Group, "id" | "name">[] | undefined;
  groupsLoaded: boolean;
  selectedGroupId: string | null;
}): { groupId: string | null; shouldClear: boolean; options: { id: string; name: string }[] } {
  const shouldClear = !!selectedGroupId && groupsLoaded
    && !groups?.some(group => group.id === selectedGroupId)
    && !threads.some(thread => thread.group_id === selectedGroupId);
  const groupId = shouldClear ? null : selectedGroupId;
  return { groupId, shouldClear, options: threadGroupOptions(threads, groups, groupId) };
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
