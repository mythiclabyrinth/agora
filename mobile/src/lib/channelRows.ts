/* The channel list's rows: messages in order, with one "New" divider where
   the history first crosses the read marker. */

import type { Message } from "@agora/core";

export type ChannelRow = { kind: "msg"; m: Message } | { kind: "divider" };

/** `marker` is the snapshotted read marker (0: no divider). Only the first
    crossing gets a divider: a queued message bumped to a newer seq keeps
    its old id and can cross back and forth, and a second "divider" row would
    both move the landing past the first unread and repeat the row key. */
export function channelRows(
  chronological: Message[],
  marker: number,
): { rows: ChannelRow[]; firstUnread: Message | undefined } {
  const rows: ChannelRow[] = [];
  let firstUnread: Message | undefined;
  for (const m of chronological) {
    if (marker > 0 && !firstUnread && rows.length > 0) {
      const prev = rows[rows.length - 1];
      if (prev.kind === "msg" && prev.m.id <= marker && m.id > marker) {
        rows.push({ kind: "divider" });
        firstUnread = m;
      }
    }
    rows.push({ kind: "msg", m });
  }
  return { rows, firstUnread };
}
