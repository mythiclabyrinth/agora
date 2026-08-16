import { describe, expect, it } from "vitest";
import { decideInbound, parseConversationId, resolveRoute } from "./policy.ts";
import type { ResolvedAgoraAccount } from "./config.ts";
import type { AgoraInboundFrame } from "./protocol.ts";

const account = (over: Partial<ResolvedAgoraAccount> = {}): ResolvedAgoraAccount =>
  ({
    accountId: "default",
    url: "https://agora.example",
    token: "tok",
    socketUrl: "wss://agora.example/agent/ws?token=tok",
    agentId: "openclaw",
    agentName: "OpenClaw",
    requireMention: false,
    allowFrom: ["alice"],
    dmPolicy: undefined,
    maxFileBytes: 10 * 1024 * 1024,
    contextFeed: false,
    config: {},
    ...over,
  }) as ResolvedAgoraAccount;

const frame = (over: Partial<AgoraInboundFrame> = {}): AgoraInboundFrame => ({
  type: "inbound",
  agent_id: "openclaw",
  channel_id: "c1",
  text: "hello",
  author: { id: "alice", name: "Alice", type: "user" },
  ...over,
});

describe("decideInbound", () => {
  it("admits an allowlisted human", () => {
    expect(decideInbound({ frame: frame(), account: account() })).toEqual({ handle: true });
  });

  it("refuses a sender who is not on the allowlist", () => {
    const decision = decideInbound({ frame: frame({ author: { id: "mallory", type: "user" } }), account: account() });
    expect(decision).toMatchObject({ handle: false });
    expect(decision).toMatchObject({ reason: expect.stringContaining("allowlist") });
  });

  it("ignores agent-authored messages unless the context feed is on", () => {
    const agentFrame = frame({
      author: { id: "codex", type: "agent" },
      mentioned: true,
      bot_turns_left: 3,
    });
    expect(decideInbound({ frame: agentFrame, account: account() })).toMatchObject({
      handle: false,
    });
    expect(decideInbound({ frame: agentFrame, account: account({ contextFeed: true }) })).toEqual({
      handle: true,
    });
  });

  it("will not answer another agent once the bot loop budget is spent", () => {
    const spent = frame({
      author: { id: "codex", type: "agent" },
      mentioned: true,
      bot_turns_left: 0,
    });
    expect(decideInbound({ frame: spent, account: account({ contextFeed: true }) })).toMatchObject({
      reason: "bot loop budget exhausted",
    });
  });

  it("stays silent when another agent holds the floor", () => {
    const decision = decideInbound({
      frame: frame({ any_mention: true, mentioned: false }),
      account: account(),
    });
    expect(decision).toMatchObject({ reason: "floor closed" });
  });

  it("stays silent when require_agent closed the floor without a tag", () => {
    // Same reason as a peer-tag closed floor: the frame cannot express the
    // overlap (require_agent is also true whenever a peer was tagged via the
    // any_mention OR), so the skip string stays honest for both cases.
    const decision = decideInbound({
      frame: frame({ any_mention: true, mentioned: false, require_agent: true }),
      account: account(),
    });
    expect(decision).toMatchObject({ handle: false, reason: "floor closed" });
  });

  it("answers when it is the one mentioned", () => {
    expect(
      decideInbound({ frame: frame({ any_mention: true, mentioned: true }), account: account() }),
    ).toEqual({ handle: true });
  });

  it("honours requireMention", () => {
    expect(
      decideInbound({ frame: frame(), account: account({ requireMention: true }) }),
    ).toMatchObject({ reason: "no mention" });
  });

  it("drops an empty message but keeps an attachment-only one", () => {
    expect(decideInbound({ frame: frame({ text: "   " }), account: account() })).toMatchObject({
      reason: "empty message",
    });
    expect(
      decideInbound({ frame: frame({ text: "" }), account: account(), hasMedia: true }),
    ).toEqual({ handle: true });
  });
});

describe("resolveRoute", () => {
  it("keeps a channel and its threads in separate conversations", () => {
    expect(resolveRoute(frame())).toMatchObject({
      channelId: "c1",
      threadId: null,
      conversationId: "c1",
      chatType: "channel",
    });
    expect(resolveRoute(frame({ thread_id: 42 }))).toMatchObject({
      channelId: "c1",
      threadId: 42,
      conversationId: "c1:42",
      chatType: "thread",
    });
  });

  it("refuses partial and fractional thread ids instead of guessing", () => {
    expect(resolveRoute(frame({ thread_id: "12abc" as never })).threadId).toBeNull();
    expect(resolveRoute(frame({ thread_id: 1.9 as never })).threadId).toBeNull();
  });

  it("treats an unparseable thread id as the channel root", () => {
    expect(resolveRoute(frame({ thread_id: "not-a-number" })).threadId).toBeNull();
  });
});

describe("parseConversationId", () => {
  it("round-trips a threaded conversation", () => {
    expect(parseConversationId("c1:42")).toEqual({ channelId: "c1", threadId: 42 });
    expect(parseConversationId("c1")).toEqual({ channelId: "c1", threadId: null });
  });

  it("does not mistake a colon in a channel id for a thread", () => {
    expect(parseConversationId("team:general")).toEqual({
      channelId: "team:general",
      threadId: null,
    });
  });
});
