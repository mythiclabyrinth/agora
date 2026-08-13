import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { describe, expect, it } from "vitest";
import { AgoraClient } from "./client.ts";
import type { AgoraInboundFrame } from "./protocol.ts";

/** Minimal stand-in for the `ws` socket the client drives. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  closed = false;

  send(payload: string, callback?: (error?: Error) => void): void {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
    callback?.();
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  emitOpen(): void {
    this.emit("open");
  }

  emitFrame(frame: unknown): void {
    this.emit("message", JSON.stringify(frame));
  }

  framesOfType(type: string): Record<string, unknown>[] {
    return this.sent.filter(frame => frame.type === type);
  }
}

class DeferredSendSocket extends FakeSocket {
  sendCallback?: (error?: Error) => void;

  override send(payload: string, callback?: (error?: Error) => void): void {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
    this.sendCallback = callback;
  }
}

function createClient(over: Partial<ConstructorParameters<typeof AgoraClient>[0]> = {}) {
  const sockets: FakeSocket[] = [];
  const inbound: AgoraInboundFrame[] = [];
  const warnings: string[] = [];
  const client = new AgoraClient({
    socketUrl: "wss://agora.example/agent/ws?token=tok",
    agentId: "openclaw",
    agentName: "OpenClaw",
    requireMention: false,
    contextFeed: false,
    ackGraceMs: 5,
    onInbound: frame => {
      inbound.push(frame);
    },
    warn: message => warnings.push(message),
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    ...over,
  });
  return { client, sockets, inbound, warnings };
}

describe("AgoraClient", () => {
  it("announces the agent roster before anything else", async () => {
    const { client, sockets } = createClient();
    client.start();
    sockets[0]!.emitOpen();
    const hello = sockets[0]!.sent[0]!;
    expect(hello).toMatchObject({
      type: "hello",
      agents: [
        { id: "openclaw", name: "OpenClaw", requires_mention: false, wants_context_feed: false },
      ],
    });
    await client.stop();
  });

  it("delivers inbound frames and ignores everything else", async () => {
    const { client, sockets, inbound } = createClient();
    client.start();
    sockets[0]!.emitOpen();
    sockets[0]!.emitFrame({ type: "inbound", channel_id: "c1", text: "hi" });
    sockets[0]!.emitFrame({ type: "presence", channel_id: "c1" });
    sockets[0]!.emit("message", "not json");
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.text).toBe("hi");
    await client.stop();
  });

  it("echoes the thread id on a post", async () => {
    const { client, sockets } = createClient();
    client.start();
    sockets[0]!.emitOpen();
    await client.post({ channelId: "c1", threadId: 42, text: "reply" });
    expect(sockets[0]!.framesOfType("post")[0]).toMatchObject({
      channel_id: "c1",
      thread_id: 42,
      text: "reply",
    });
    await client.stop();
  });

  it("fails a post that Agora rejects instead of reporting it delivered", async () => {
    const { client, sockets } = createClient({ ackGraceMs: 200 });
    client.start();
    sockets[0]!.emitOpen();
    const pending = client.post({ channelId: "c1", threadId: null, text: "nope" });
    const requestId = sockets[0]!.framesOfType("post")[0]!.request_id as string;
    sockets[0]!.emitFrame({
      type: "error",
      frame_type: "post",
      request_id: requestId,
      error: "agent is not a member of this channel",
    });
    await expect(pending).rejects.toThrow(/not a member/);
    await client.stop();
  });

  it("logs an uncorrelated rejection without failing a send", async () => {
    const { client, sockets, warnings } = createClient();
    client.start();
    sockets[0]!.emitOpen();
    sockets[0]!.emitFrame({ type: "error", frame_type: "typing", error: "nope" });
    expect(warnings.join(" ")).toContain("nope");
    await client.stop();
  });

  it("clears typing indicators when the channel stops", async () => {
    const { client, sockets } = createClient();
    client.start();
    sockets[0]!.emitOpen();
    await client.setTyping("c1", 42, true);
    await client.stop();
    const typing = sockets[0]!.framesOfType("typing");
    expect(typing[0]).toMatchObject({ channel_id: "c1", thread_id: 42, active: true });
    expect(typing[1]).toMatchObject({ channel_id: "c1", thread_id: 42, active: false });
  });

  it("drops a reaction for a non-numeric message id", async () => {
    const { client, sockets } = createClient();
    client.start();
    sockets[0]!.emitOpen();
    await client.react({ channelId: "c1", messageId: "abc", emoji: "👀", action: "add" });
    await client.react({ channelId: "c1", messageId: 7, emoji: "👀", action: "add" });
    expect(sockets[0]!.framesOfType("reaction")).toHaveLength(1);
    await client.stop();
  });

  it("re-announces the roster after a reconnect", async () => {
    const { client, sockets } = createClient();
    client.start();
    sockets[0]!.emitOpen();
    sockets[0]!.emit("close", 1006, Buffer.from(""));
    await new Promise(resolve => setTimeout(resolve, 1_200));
    expect(sockets.length).toBeGreaterThan(1);
    sockets[1]!.emitOpen();
    expect(sockets[1]!.sent[0]).toMatchObject({ type: "hello" });
    await client.stop();
  });

  it("fails pending posts when the connection drops", async () => {
    const { client, sockets } = createClient({ ackGraceMs: 5_000 });
    client.start();
    sockets[0]!.emitOpen();
    const pending = client.post({ channelId: "c1", threadId: null, text: "hi" });
    sockets[0]!.emit("close", 1006, Buffer.from(""));
    await expect(pending).rejects.toThrow(/closed/);
    await client.stop();
  });

  it("does not leak an unhandled rejection when close wins the send race", async () => {
    const socket = new DeferredSendSocket();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    const { client } = createClient({
      ackGraceMs: 5_000,
      createSocket: () => socket as unknown as WebSocket,
    });
    try {
      client.start();
      socket.emitOpen();
      socket.sendCallback?.(); // complete hello
      const pending = client.post({ channelId: "c1", threadId: null, text: "hi" });
      socket.emit("close", 1006, Buffer.from(""));
      socket.sendCallback?.(new Error("send failed after close"));
      await expect(pending).rejects.toThrow(/send failed after close/);
      await new Promise(resolve => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
      await client.stop();
    }
  });

  it("refuses to send while disconnected", async () => {
    const { client } = createClient();
    await expect(client.post({ channelId: "c1", threadId: null, text: "hi" })).rejects.toThrow(
      /not connected/,
    );
  });
});
