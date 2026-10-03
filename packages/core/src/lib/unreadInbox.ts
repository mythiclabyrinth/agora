import type { UnreadItem } from "../api/types";

export type UnreadFilter = "all" | "mentions" | "channels" | "threads";

/** The server counts only the newest 100 unread messages per conversation. */
export function formatUnreadCount(count: number): string {
  return count >= 100 ? "99+" : String(count);
}

export function filterUnreads(items: UnreadItem[], filter: UnreadFilter): UnreadItem[] {
  if (filter === "all") return items;
  if (filter === "mentions") return items.filter(item => item.mentions > 0);
  return items.filter(item => item.kind === (filter === "channels" ? "channel" : "thread"));
}
