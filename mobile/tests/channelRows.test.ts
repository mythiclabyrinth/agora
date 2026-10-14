import type { Message } from "@agora/core";
import { channelRows } from "../src/lib/channelRows";

const msg = (id: number) => ({ id }) as Message;
const ids = (rows: ReturnType<typeof channelRows>["rows"]) =>
  rows.map((r) => (r.kind === "divider" ? "divider" : r.m.id));

describe("channelRows", () => {
  it("puts one divider where the history first crosses the read marker", () => {
    const { rows, firstUnread } = channelRows([msg(90), msg(95), msg(101), msg(102)], 95);
    expect(ids(rows)).toEqual([90, 95, "divider", 101, 102]);
    expect(firstUnread?.id).toBe(101);
  });

  it("keeps the first crossing when a bumped old message crosses back", () => {
    // 50 was queued and bumped to a newer seq, so it sorts among the unread.
    const { rows, firstUnread } = channelRows([msg(90), msg(101), msg(50), msg(102)], 95);
    expect(ids(rows)).toEqual([90, "divider", 101, 50, 102]);
    expect(firstUnread?.id).toBe(101);
  });

  it("has no divider with nothing unread or no read history loaded", () => {
    expect(ids(channelRows([msg(1), msg(2)], 0).rows)).toEqual([1, 2]);
    expect(channelRows([msg(101), msg(102)], 95).firstUnread).toBeUndefined();
  });
});
