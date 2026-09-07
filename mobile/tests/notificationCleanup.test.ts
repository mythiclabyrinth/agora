import {
  conversationKey,
  obsoleteNotificationIds,
} from "../src/lib/notificationCleanup";

const groups = [{ channels: [
  { id: "c1", unread: 0, last_read_id: 20 },
  { id: "c2", unread: 2, last_read_id: 8 },
] }];
const threads = [
  { root: { id: 42 }, unread: 0, last_read_id: 30 },
  { root: { id: 43 }, unread: 2, last_read_id: 12 },
];

describe("notification cleanup", () => {
  it.each([true, "true", false, "false"])("handles pending flag %s when the conversation is read", (pending_interaction) => {
    expect(obsoleteNotificationIds([
      { identifier: "pending", data: { channel_id: "c1", message_id: 1, pending_interaction } },
    ], groups, threads)).toEqual(pending_interaction === true || pending_interaction === "true" ? [] : ["pending"]);
  });
  it("uses stable channel and thread conversation keys", () => {
    expect(conversationKey("c1")).toBe("channel:c1");
    expect(conversationKey("c1", 42)).toBe("thread:42");
  });

  it("clears read cards while preserving newer and unrelated cards", () => {
    const ids = obsoleteNotificationIds([
      { identifier: "old-channel", data: { channel_id: "c1", message_id: 20 } },
      { identifier: "new-channel", data: { channel_id: "c1", message_id: 21 } },
      { identifier: "old-thread", data: { channel_id: "c1", thread_id: 42, message_id: 30 } },
      { identifier: "new-thread", data: { channel_id: "c1", thread_id: 43, message_id: 13 } },
      { identifier: "other", data: { channel_id: "unknown", message_id: 1 } },
    ], groups, threads);
    expect(ids).toEqual(["old-channel", "old-thread"]);
  });

  it("keeps channel and thread read domains isolated", () => {
    const ids = obsoleteNotificationIds([
      { identifier: "thread", data: { channel_id: "c1", thread_id: 43, message_id: 13 } },
      { identifier: "channel", data: { channel_id: "c2", message_id: 9 } },
    ], groups, threads);
    expect(ids).toEqual([]);
  });

  it("clears aggregate cards only when that conversation has zero unread", () => {
    const ids = obsoleteNotificationIds([
      { identifier: "read-channel", data: { channel_id: "c1" } },
      { identifier: "unread-channel", data: { channel_id: "c2" } },
      { identifier: "read-thread", data: { channel_id: "c1", thread_id: 42 } },
      { identifier: "unread-thread", data: { channel_id: "c1", thread_id: 43 } },
    ], groups, threads);
    expect(ids).toEqual(["read-channel", "read-thread"]);
  });

  it("preserves aggregate cards when unread state is missing", () => {
    const ids = obsoleteNotificationIds(
      [{ identifier: "agg", data: { channel_id: "c3" } }],
      [{ channels: [{ id: "c3", last_read_id: 5 }] }],
      [],
    );
    expect(ids).toEqual([]);
  });
});
