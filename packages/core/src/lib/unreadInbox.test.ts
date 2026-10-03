import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { filterUnreads, formatUnreadCount } from "./unreadInbox";
import { unreadReadPayload } from "../api/queries";
import { applyReadToUnreadPage, applyReadToUnreads, applyWsEvent } from "../ws/reducer";
import type { UnreadItem } from "../api/types";

const base: UnreadItem = {
  kind: "channel", channel_id: "c", channel_name: "main", group_id: "g", group_name: "G",
  thread_id: null, title: null, unread: 2, mentions: 0, first_unread_id: 1,
  ack_through_id: 2, latest_ts: 1, previews: [],
};
const items: UnreadItem[] = [base, { ...base, kind: "thread", thread_id: 3, mentions: 1 }];

describe("filterUnreads", () => {
  it("shows a capped count as 99+", () => {
    expect(formatUnreadCount(99)).toBe("99");
    expect(formatUnreadCount(100)).toBe("99+");
  });
  it("selects mentions and conversation kinds without changing the input", () => {
    expect(filterUnreads(items, "all")).toEqual(items);
    expect(filterUnreads(items, "mentions")).toEqual([items[1]]);
    expect(filterUnreads(items, "channels")).toEqual([items[0]]);
    expect(filterUnreads(items, "threads")).toEqual([items[1]]);
    expect(items).toHaveLength(2);
  });
  it("sends exact snapshot ids and markers for a filtered subset", () => {
    expect(unreadReadPayload(filterUnreads(items, "mentions"))).toEqual({ items: [
      { kind: "thread", id: 3, ack_through_id: 2 },
    ] });
  });
  it("removes only conversations covered by a read event", () => {
    expect(applyReadToUnreads(items, { type: "read", channel_id: "c", last_read_id: 0 })).toEqual(items);
    expect(applyReadToUnreads(items, { type: "read", channel_id: "c", last_read_id: 1 })).toEqual([items[1]]);
    expect(applyReadToUnreads(items, { type: "read", channel_id: "c", last_read_id: 2 })).toEqual([items[1]]);
    expect(applyReadToUnreads(items, { type: "thread_read", channel_id: "c", thread_id: 3, last_read_id: 2 })).toEqual([items[0]]);
  });
  it("keeps the full conversation count in sync with a read event", () => {
    expect(applyReadToUnreadPage({ items, total: 5 }, {
      type: "read", channel_id: "c", last_read_id: 2,
    })).toEqual({ items: [items[1]], total: 4 });
  });
  it("patches an own-post read without scheduling an unread refetch", () => {
    vi.useFakeTimers();
    try {
      const qc = new QueryClient();
      const invalidate = vi.spyOn(qc, "invalidateQueries");
      applyWsEvent(qc, {
        type: "read", channel_id: "c", last_read_id: 2,
        unread: 0, mentions: 0, from_post: true,
      }, { username: "tom" });
      vi.advanceTimersByTime(4000);
      expect(invalidate).not.toHaveBeenCalled();
      qc.clear();
    } finally {
      vi.useRealTimers();
    }
  });
});
