import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ options: undefined as any, calls: [] as any[] }));
vi.mock("./client.ts", () => ({
  AgoraClient: class {
    constructor(options: any) { state.options = options; }
    start() {}
    stop = vi.fn(async () => {});
    post = vi.fn(async (value: any) => { state.calls.push(["post", value]); return "request-1"; });
    setTyping = vi.fn(async (...value: any[]) => state.calls.push(["typing", ...value]));
    react = vi.fn(async (value: any) => state.calls.push(["react", value]));
  },
}));

import { startAgoraAccount } from "./monitor.ts";

describe("Agora monitor", () => {
  it("echoes thread replies and always clears indicators", async () => {
    state.calls.length = 0;
    const abort = new AbortController();
    const runtime = {
      routing: { resolveAgentRoute: () => ({ agentId: "main", sessionKey: "session", mainSessionKey: "main" }) },
      session: { resolveStorePath: () => "/tmp/store", recordInboundSession: vi.fn() },
      reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
      inbound: {
        buildContext: (value: unknown) => value,
        run: async ({ adapter }: any) => {
          const turn = adapter.resolveTurn();
          await turn.delivery.deliver({ text: "thread reply" });
          // Deliberately do not call onFinalize: cleanup must live in finally.
        },
      },
    };
    const running = startAgoraAccount({
      accountId: "default",
      account: {
        socketUrl: "wss://agora.example/agent/ws?token=tok", agentId: "openclaw",
        agentName: "OpenClaw", requireMention: false, contextFeed: false,
        allowFrom: ["alice"], token: "tok", maxFileBytes: 1024,
      },
      cfg: {}, channelRuntime: runtime, abortSignal: abort.signal,
      setStatus: vi.fn(), getStatus: () => ({}), log: {},
    } as never);
    while (!state.options) await new Promise(resolve => setImmediate(resolve));
    await state.options.onInbound({
      type: "inbound", channel_id: "c1", thread_id: 42, message_id: 7,
      text: "hello", author: { id: "alice", name: "Alice", type: "user" },
    });
    expect(state.calls).toContainEqual(["post", {
      channelId: "c1", threadId: 42, text: "thread reply",
    }]);
    expect(state.calls).toContainEqual(["typing", "c1", 42, false]);
    expect(state.calls).toContainEqual(["react", {
      channelId: "c1", messageId: 7, emoji: "☑️", action: "add",
    }]);
    abort.abort();
    await running;
  });
});
