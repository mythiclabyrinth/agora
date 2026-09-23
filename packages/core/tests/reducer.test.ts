/* The pure page-set transforms behind live updates. */

import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { appendMessage, applyAliasToPages, applyMessageClear, applyMessageDelete, applyMessageUpdate, applyWsEvent, moveMessage, replaceMessage, resetSeenMessageIds, type MessagePages } from "../src/ws/reducer";
import { flattenMessages } from "../src/api/queries";
import { keys } from "../src/api/keys";
import type { AgentUsageResponse, Message, PinnedMessage, StarredMessage, ThreadRow } from "../src/api/types";

const msg = (id: number, text = `m${id}`): Message =>
  ({
    id, channel_id: "c1", text, ts: id, author_id: "me", author_name: "me",
    author_type: "user", thread_id: null, reply_count: 0, alias: null, meta: null,
  } as unknown as Message);

const pages = (...ids: number[][]): MessagePages =>
  ({ pages: ids.map(p => p.map(id => msg(id))), pageParams: ids.map(() => undefined) });

describe("appendMessage", () => {
  it("appends to the newest page (pages[0], newest-last)", () => {
    const next = appendMessage(pages([3, 4], [1, 2]), msg(5));
    expect(next!.pages[0].map(m => m.id)).toEqual([3, 4, 5]);
    expect(next!.pages[1].map(m => m.id)).toEqual([1, 2]);
  });
  it("inserts by seq even when ids arrived in a different order", () => {
    const next = appendMessage({ pages: [[{ ...msg(9), seq: 30 }, { ...msg(8), seq: 40 }]], pageParams: [undefined] }, { ...msg(7), seq: 35 });
    expect(next!.pages[0].map(m => m.id)).toEqual([9, 7, 8]);
  });
  it("dedupes an id that already landed (own POST + WS echo)", () => {
    const next = appendMessage(pages([3, 4]), msg(4));
    expect(next!.pages[0].map(m => m.id)).toEqual([3, 4]);
  });
  it("starts a page set when the cache is empty", () => {
    const next = appendMessage(undefined, msg(1));
    expect(next === undefined || next.pages.flat().some(m => m.id === 1)).toBe(true);
  });
});

describe("moveMessage", () => {
  it("updates a message in place without changing page lengths", () => {
    const next = moveMessage({ pages: [[{ ...msg(5), seq: 50 }], [{ ...msg(2), seq: 20 }, { ...msg(3), seq: 30 }]], pageParams: [undefined, undefined] }, 2, 60);
    expect(next!.pages[0].map(m => m.id)).toEqual([5]);
    expect(next!.pages[1].map(m => m.id)).toEqual([2, 3]);
  });
});

describe("flattenMessages", () => {
  it("sorts messages by seq across pages after a move", () => {
    const result = flattenMessages({ pages: [[{ ...msg(3), seq: 30 }], [{ ...msg(1), seq: 10 }, { ...msg(2), seq: 40 }]], pageParams: [undefined, undefined] });
    expect(result.map(m => m.id)).toEqual([1, 3, 2]);
  });
});

describe("replaceMessage", () => {
  it("swaps a message in place", () => {
    const next = replaceMessage(pages([1, 2, 3]), msg(2, "edited"));
    expect(next!.pages[0].find(m => m.id === 2)!.text).toBe("edited");
    expect(next!.pages[0].map(m => m.id)).toEqual([1, 2, 3]);
  });
  it("leaves the set unchanged when the id is absent", () => {
    const before = pages([1, 2]);
    const next = replaceMessage(before, msg(9));
    expect(next!.pages[0].map(m => m.id)).toEqual([1, 2]);
  });
});

describe("applyAliasToPages", () => {
  it("patches the renamed root's alias in place", () => {
    const next = applyAliasToPages(pages([1, 2, 3]), 2, "Launch plan");
    expect(next!.pages[0].find(m => m.id === 2)!.alias).toBe("Launch plan");
    expect(next!.pages[0].find(m => m.id === 1)!.alias).toBeNull();
  });
  it("clears back to null and ignores absent ids", () => {
    const cleared = applyAliasToPages(applyAliasToPages(pages([1]), 1, "x"), 1, null);
    expect(cleared!.pages[0][0].alias).toBeNull();
    const untouched = pages([1, 2]);
    expect(applyAliasToPages(untouched, 9, "x")).toBe(untouched);
    expect(applyAliasToPages(undefined, 1, "x")).toBeUndefined();
  });
});

describe("applyMessageUpdate", () => {
  it("refreshes message, thread, pin, and star previews", () => {
    const qc = new QueryClient();
    const old = msg(1, "old");
    qc.setQueryData(keys.messages("c1", null), pages([1]));
    qc.setQueryData<ThreadRow[]>(keys.threads, [{ root: old } as ThreadRow]);
    qc.setQueryData<PinnedMessage[]>(keys.pins("c1"), [{ ...old, pinned_at: 1, pinned_by: null }]);
    qc.setQueryData<StarredMessage[]>(keys.stars("c1"), [{ ...msg(2), starred_at: 1, root: old }]);
    applyMessageUpdate(qc, { ...old, text: "edited", meta: { edited_at: 2 } });
    expect(qc.getQueryData<MessagePages>(keys.messages("c1", null))!.pages[0][0].text).toBe("edited");
    expect(qc.getQueryData<ThreadRow[]>(keys.threads)![0].root.text).toBe("edited");
    expect(qc.getQueryData<PinnedMessage[]>(keys.pins("c1"))![0].text).toBe("edited");
    expect(qc.getQueryData<StarredMessage[]>(keys.stars("c1"))![0].root!.text).toBe("edited");
  });

  it("preserves unrelated cache references", () => {
    const qc = new QueryClient();
    const threads = [{ root: msg(9) } as ThreadRow];
    const pins = [{ ...msg(9), pinned_at: 1, pinned_by: null }];
    const stars = [{ ...msg(9), starred_at: 1, root: null }];
    qc.setQueryData(keys.threads, threads);
    qc.setQueryData(keys.pins("c1"), pins);
    qc.setQueryData(keys.stars("c1"), stars);
    applyMessageUpdate(qc, msg(1, "edited"));
    expect(qc.getQueryData(keys.threads)).toBe(threads);
    expect(qc.getQueryData(keys.pins("c1"))).toBe(pins);
    expect(qc.getQueryData(keys.stars("c1"))).toBe(stars);
  });
});

describe("agent usage events", () => {
  it("preserves server-computed staleness on a provider update", () => {
    const qc = new QueryClient();
    qc.setQueryData<AgentUsageResponse>(keys.agentUsage("claude"), {
      usage: null, refreshing: true, stale: true,
    });
    applyWsEvent(qc, {
      type: "agent_usage", agent_id: "claude",
      usage: { agent_id: "claude", provider: "claude", availability: "available", captured_at: 10,
        windows: [{ key: "five_hour", label: "Current session", used_percent: 34, window_minutes: 300, resets_at: 20 }] },
      stale: true,
    }, { username: "me" });
    const next = qc.getQueryData<AgentUsageResponse>(keys.agentUsage("claude"))!;
    expect(next.usage?.windows[0].used_percent).toBe(34);
    expect(next.refreshing).toBe(false);
    expect(next.stale).toBe(true);
  });

  it("defaults missing stale to false for older hubs", () => {
    const qc = new QueryClient();
    qc.setQueryData<AgentUsageResponse>(keys.agentUsage("claude"), {
      usage: null, refreshing: true, stale: true,
    });
    applyWsEvent(qc, {
      type: "agent_usage", agent_id: "claude",
      usage: { agent_id: "claude", provider: "claude", availability: "available", captured_at: 10,
        windows: [{ key: "five_hour", label: "Current session", used_percent: 12, window_minutes: 300, resets_at: 20 }] },
    }, { username: "me" });
    const next = qc.getQueryData<AgentUsageResponse>(keys.agentUsage("claude"))!;
    expect(next.refreshing).toBe(false);
    expect(next.stale).toBe(false);
  });
});

describe("attachment browser invalidation", () => {
  it("invalidates channel and thread attachment pages when a message is deleted", async () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.attachments("c1", null), { pages: [], pageParams: [] });
    qc.setQueryData(keys.attachments("c1", 42), { pages: [], pageParams: [] });
    applyWsEvent(qc, {
      type: "message_delete", channel_id: "c1", message_id: 9, thread_id: 42,
    }, { username: "me" });
    await Promise.resolve();
    expect(qc.getQueryState(keys.attachments("c1", null))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(keys.attachments("c1", 42))?.isInvalidated).toBe(true);
  });
});

describe("applyMessageClear", () => {
  it("empties a channel and removes only that channel's thread caches", () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.messages("c1", null), pages([1, 2]));
    qc.setQueryData(keys.messages("c1", 1), pages([3]));
    qc.setQueryData(keys.messages("c2", 9), pages([10]));
    qc.setQueryData<ThreadRow[]>(keys.threads, [
      { root: msg(1), channel_id: "c1" } as ThreadRow,
      { root: { ...msg(9), channel_id: "c2" }, channel_id: "c2" } as ThreadRow,
    ]);
    applyMessageClear(qc, { type: "message_clear", channel_id: "c1", thread_id: null });
    expect(flattenMessages(qc.getQueryData(keys.messages("c1", null)))).toEqual([]);
    expect(qc.getQueryData(keys.messages("c1", 1))).toBeUndefined();
    expect(flattenMessages(qc.getQueryData(keys.messages("c2", 9))).map(m => m.id)).toEqual([10]);
    expect(qc.getQueryData<ThreadRow[]>(keys.threads)?.map(row => row.channel_id)).toEqual(["c2"]);
  });

  it("clears replies and resets the surviving root's reply count", () => {
    const qc = new QueryClient();
    const root = { ...msg(5), reply_count: 2 };
    qc.setQueryData(keys.messages("c1", null), {
      pages: [[root, msg(6)]], pageParams: [undefined],
    });
    qc.setQueryData(keys.messages("c1", 5), {
      pages: [[{ ...msg(7), thread_id: 5 }, { ...msg(8), thread_id: 5 }]],
      pageParams: [undefined],
    });
    qc.setQueryData<ThreadRow[]>(keys.threads, [{
      root, channel_id: "c1", reply_count: 2, unread: 2,
    } as ThreadRow]);
    applyWsEvent(qc, { type: "message_clear", channel_id: "c1", thread_id: 5 }, { username: "me" });
    expect(flattenMessages(qc.getQueryData(keys.messages("c1", 5)))).toEqual([]);
    expect(flattenMessages(qc.getQueryData(keys.messages("c1", null)))[0].reply_count).toBe(0);
    expect(qc.getQueryData<ThreadRow[]>(keys.threads)?.[0]).toMatchObject({ reply_count: 0, unread: 0 });
  });
});

describe("applyWsEvent message dedupe", () => {
  it("applies a duplicate message frame only once", () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.messages("c1", null), {
      pages: [[{ ...msg(5), reply_count: 0 }]],
      pageParams: [undefined],
    });
    qc.setQueryData(keys.messages("c1", 5), pages());
    const reply = { ...msg(11), thread_id: 5 };
    applyWsEvent(qc, { type: "message", message: reply }, { username: "me" });
    applyWsEvent(qc, { type: "message", message: reply }, { username: "me" });
    expect(qc.getQueryData<MessagePages>(keys.messages("c1", null))!.pages[0][0].reply_count).toBe(1);
    expect(qc.getQueryData<MessagePages>(keys.messages("c1", 5))!.pages[0].map(m => m.id)).toEqual([11]);
  });

  it("still bumps after an optimistic append that never touched the seen-set", () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.messages("c1", null), {
      pages: [[{ ...msg(5), reply_count: 0 }]],
      pageParams: [undefined],
    });
    const reply = { ...msg(11), thread_id: 5 };
    qc.setQueryData(keys.messages("c1", 5), appendMessage(pages(), reply));
    applyWsEvent(qc, { type: "message", message: reply }, { username: "me" });
    expect(qc.getQueryData<MessagePages>(keys.messages("c1", null))!.pages[0][0].reply_count).toBe(1);
  });

  it("resetSeenMessageIds lets the same id apply again after a switch or restore", () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.messages("c1", null), {
      pages: [[{ ...msg(5), reply_count: 0 }]],
      pageParams: [undefined],
    });
    qc.setQueryData(keys.messages("c1", 5), pages());
    const reply = { ...msg(11), thread_id: 5 };
    applyWsEvent(qc, { type: "message", message: reply }, { username: "me" });
    // Covers server switch and same-server backup restore (rowids restart
    // while baseUrl/token stay put) — hooks call this from onReopen too.
    resetSeenMessageIds(qc);
    qc.setQueryData(keys.messages("c1", null), {
      pages: [[{ ...msg(5), reply_count: 0 }]],
      pageParams: [undefined],
    });
    qc.setQueryData(keys.messages("c1", 5), pages());
    applyWsEvent(qc, { type: "message", message: reply }, { username: "me" });
    expect(qc.getQueryData<MessagePages>(keys.messages("c1", null))!.pages[0][0].reply_count).toBe(1);
  });

  it("delete-own-reply plus WS echo only drops reply_count once", () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.messages("c1", null), {
      pages: [[{ ...msg(5), reply_count: 2 }]],
      pageParams: [undefined],
    });
    qc.setQueryData(keys.messages("c1", 5), {
      pages: [[{ ...msg(7), thread_id: 5 }, { ...msg(8), thread_id: 5 }]],
      pageParams: [undefined],
    });
    const ev = {
      type: "message_delete" as const,
      channel_id: "c1",
      message_id: 7,
      thread_id: 5,
    };
    // Mutation onSuccess, then the hub broadcast echo.
    applyMessageDelete(qc, ev);
    applyWsEvent(qc, ev, { username: "me" });
    expect(qc.getQueryData<MessagePages>(keys.messages("c1", null))!.pages[0][0].reply_count).toBe(1);
    expect(qc.getQueryData<MessagePages>(keys.messages("c1", 5))!.pages[0].map(m => m.id)).toEqual([8]);
  });

  it("separate QueryClients each apply the same message id independently", () => {
    const a = new QueryClient();
    const b = new QueryClient();
    for (const qc of [a, b]) {
      qc.setQueryData(keys.messages("c1", null), {
        pages: [[{ ...msg(5), reply_count: 0 }]],
        pageParams: [undefined],
      });
      qc.setQueryData(keys.messages("c1", 5), pages());
    }
    const reply = { ...msg(11), thread_id: 5 };
    applyWsEvent(a, { type: "message", message: reply }, { username: "me" });
    applyWsEvent(b, { type: "message", message: reply }, { username: "me" });
    expect(a.getQueryData<MessagePages>(keys.messages("c1", null))!.pages[0][0].reply_count).toBe(1);
    expect(b.getQueryData<MessagePages>(keys.messages("c1", null))!.pages[0][0].reply_count).toBe(1);
  });

  it("resetSeenMessageIds clears the delete gate so a later delete can drop again", () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.messages("c1", null), {
      pages: [[{ ...msg(5), reply_count: 2 }]],
      pageParams: [undefined],
    });
    qc.setQueryData(keys.messages("c1", 5), {
      pages: [[{ ...msg(7), thread_id: 5 }, { ...msg(8), thread_id: 5 }]],
      pageParams: [undefined],
    });
    const ev = {
      type: "message_delete" as const,
      channel_id: "c1",
      message_id: 7,
      thread_id: 5,
    };
    applyMessageDelete(qc, ev);
    expect(qc.getQueryData<MessagePages>(keys.messages("c1", null))!.pages[0][0].reply_count).toBe(1);
    // Echo is gated — no second drop.
    applyMessageDelete(qc, ev);
    expect(qc.getQueryData<MessagePages>(keys.messages("c1", null))!.pages[0][0].reply_count).toBe(1);

    resetSeenMessageIds(qc);
    // Restore a reply_count as if a new instance reused the rowid, then
    // deleting id 7 again must be allowed to drop once.
    qc.setQueryData(keys.messages("c1", null), {
      pages: [[{ ...msg(5), reply_count: 2 }]],
      pageParams: [undefined],
    });
    qc.setQueryData(keys.messages("c1", 5), {
      pages: [[{ ...msg(7), thread_id: 5 }, { ...msg(8), thread_id: 5 }]],
      pageParams: [undefined],
    });
    applyMessageDelete(qc, ev);
    expect(qc.getQueryData<MessagePages>(keys.messages("c1", null))!.pages[0][0].reply_count).toBe(1);
  });
});

describe("message_move events", () => {
  it("relocates the cached message", () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.messages("c1", null), { pages: [[{ ...msg(3), seq: 30 }], [{ ...msg(1), seq: 10 }]], pageParams: [undefined, undefined] });
    applyWsEvent(qc, { type: "message_move", channel_id: "c1", thread_id: null, message_id: 1, seq: 40 }, { username: "me" });
    expect(qc.getQueryData<MessagePages>(keys.messages("c1", null))!.pages.flat().map(m => m.id)).toEqual([3, 1]);
  });
  it("invalidates the page when the moved message is not cached", async () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.messages("c1", null), { pages: [[]], pageParams: [undefined] });
    applyWsEvent(qc, { type: "message_move", channel_id: "c1", thread_id: null, message_id: 99, seq: 40 }, { username: "me" });
    await Promise.resolve();
    expect(qc.getQueryState(keys.messages("c1", null))?.isInvalidated).toBe(true);
  });
});
