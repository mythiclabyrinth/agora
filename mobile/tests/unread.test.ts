import {
  channelsToNotify,
  mentionsMe,
  notificationTarget,
  snapshotOf,
  totalMentions,
  totalThreadUnread,
  totalUnread,
  unreadChannels,
} from "@agora/core";
import type { Group, ThreadRow } from "@agora/core";

function groups(): Group[] {
  return [
    {
      id: "g1",
      name: "Home",
      description: "",
      created_by: null,
      created_at: 0,
      role: "admin",
      channels: [
        { id: "c1", group_id: "g1", name: "general", topic: "", created_at: 0, unread: 2, mentions: 1 },
        { id: "c2", group_id: "g1", name: "random", topic: "", created_at: 0, unread: 0 },
      ],
    },
    {
      id: "g2",
      name: "Work",
      description: "",
      created_by: null,
      created_at: 0,
      role: "admin",
      channels: [
        // The groups endpoint always embeds unread, but the type is optional.
        { id: "c3", group_id: "g2", name: "standup", topic: "", created_at: 0 },
      ],
    },
  ];
}

describe("unreadChannels / totals", () => {
  it("flattens groups with group names attached", () => {
    const channels = unreadChannels(groups());
    expect(channels).toEqual([
      { id: "c1", name: "general", group: "Home", unread: 2, mentions: 1 },
      { id: "c2", name: "random", group: "Home", unread: 0, mentions: 0 },
      { id: "c3", name: "standup", group: "Work", unread: 0, mentions: 0 },
    ]);
    expect(totalUnread(groups())).toBe(2);
    expect(totalMentions(groups())).toBe(1);
  });

  it("sums thread unreads", () => {
    const threads = [{ unread: 2 }, { unread: 0 }, { unread: 3 }] as ThreadRow[];
    expect(totalThreadUnread(threads)).toBe(5);
  });
});

describe("mentionsMe", () => {
  it("matches @username case-insensitively at token boundaries", () => {
    expect(mentionsMe("hey @tom, look", "tom")).toBe(true);
    expect(mentionsMe("hey @Tom", "tom")).toBe(true);
    expect(mentionsMe("@tom leads", "tom")).toBe(true);
    expect(mentionsMe("(@tom)", "tom")).toBe(true);
  });

  it("trims trailing punctuation like the server", () => {
    expect(mentionsMe("ping @tom.", "tom")).toBe(true);
    expect(mentionsMe("ping @tom-", "tom")).toBe(true);
    expect(mentionsMe("ping @tom_", "tom")).toBe(true);
    expect(mentionsMe("ping @tom_", "tom_")).toBe(true);
    expect(mentionsMe("ping @tom.x", "tom")).toBe(false);
  });

  it("rejects lookalikes and other users", () => {
    expect(mentionsMe("hey @tommy", "tom")).toBe(false);
    expect(mentionsMe("mail me a@tom.com", "tom")).toBe(false);
    expect(mentionsMe("hey @alice", "tom")).toBe(false);
    expect(mentionsMe("no mention here", "tom")).toBe(false);
    expect(mentionsMe("anything", "")).toBe(false);
  });
});

describe("channelsToNotify", () => {
  const channels = unreadChannels(groups());

  it("baselines silently on first run (no snapshot)", () => {
    expect(channelsToNotify(null, channels)).toEqual([]);
  });

  it("notifies only channels whose unread grew, with the delta", () => {
    const prev = snapshotOf(channels); // c1: 2
    const next = channels.map((c) => (c.id === "c1" ? { ...c, unread: 5 } : c));
    const notices = channelsToNotify(prev, next);
    expect(notices.map((n) => n.channel.id)).toEqual(["c1"]);
    expect(notices[0].newCount).toBe(3);
  });

  it("notifies on mention growth even when the count is flat (thread @you)", () => {
    const prev = snapshotOf(channels);
    const next = channels.map((c) => (c.id === "c2" ? { ...c, mentions: 1 } : c));
    const notices = channelsToNotify(prev, next);
    expect(notices.map((n) => n.channel.id)).toEqual(["c2"]);
    expect(notices[0].newCount).toBe(0);
    expect(notices[0].newMentions).toBe(1);
  });

  it("treats channels missing from the snapshot as previously zero", () => {
    const next = channels.map((c) => (c.id === "c3" ? { ...c, unread: 1 } : c));
    expect(channelsToNotify({}, next).map((n) => n.channel.id)).toEqual(["c1", "c3"]);
  });

  it("accepts legacy numeric snapshots (pre-mentions installs)", () => {
    const prev = { c1: 2, c2: 0, c3: 0 };
    const next = channels.map((c) => (c.id === "c1" ? { ...c, unread: 3 } : c));
    const notices = channelsToNotify(prev, next);
    // c1 unread grew 2->3; its mention (unknown to the old snapshot) also counts.
    expect(notices.map((n) => n.channel.id)).toEqual(["c1"]);
    expect(notices[0].newCount).toBe(1);
  });

  it("never notifies when unread dropped (read elsewhere)", () => {
    const prev = snapshotOf(channels);
    const next = channels.map((c) => ({ ...c, unread: 0, mentions: 0 }));
    expect(channelsToNotify(prev, next)).toEqual([]);
  });
});

describe("notificationTarget", () => {
  it("routes to the channel", () => {
    expect(notificationTarget({ channel_id: "c1", thread_id: null })).toBe("/channel/c1");
  });

  it("routes to the thread when present", () => {
    expect(notificationTarget({ channel_id: "c1", thread_id: 42 })).toBe("/thread/c1/42");
  });

  it("rejects payloads without a channel", () => {
    expect(notificationTarget(null)).toBeNull();
    expect(notificationTarget({})).toBeNull();
    expect(notificationTarget({ channel_id: 7 })).toBeNull();
  });
});
