/* Socket lifecycle: identity-guarded reconnect so wake/orphan close cannot
   accumulate live sockets (the root cause of inflated reply badges). */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAgoraSocket,
  type AgoraWebSocket,
  type AgoraWebSocketConstructor,
} from "../src/ws/socket";
import type { WsEvent } from "../src/api/types";

class FakeWebSocket implements AgoraWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    // Mirror browsers: onclose is async relative to close().
    queueMicrotask(() => this.onclose?.(null));
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(null);
  }

  deliver(ev: WsEvent) {
    this.onmessage?.({ data: JSON.stringify(ev) });
  }
}

const FakeWS = FakeWebSocket as unknown as AgoraWebSocketConstructor;

describe("createAgoraSocket", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("wake while CONNECTING replaces the socket so only one receives frames", async () => {
    const events: WsEvent[] = [];
    const sock = createAgoraSocket(
      { url: () => "ws://test/ws", WebSocketImpl: FakeWS },
      { onEvent: (ev) => events.push(ev) },
    );
    sock.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const first = FakeWebSocket.instances[0];
    expect(first.readyState).toBe(FakeWebSocket.CONNECTING);
    // Captured before wake nulls the property, so delivering through it
    // exercises the identity guard rather than the handler teardown.
    const orphanMessage = first.onmessage!;

    sock.wake();
    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = FakeWebSocket.instances[1];
    expect(sock.current()).toBe(second);

    // Orphan close must not schedule another connect.
    await vi.runAllTimersAsync();
    expect(FakeWebSocket.instances).toHaveLength(2);

    second.open();
    const frame: WsEvent = {
      type: "message",
      message: {
        id: 1, channel_id: "c", text: "hi", ts: 1, author_id: "a",
        author_name: "a", author_type: "agent", thread_id: null,
        reply_count: 0, alias: null, meta: null, attachments: [],
      } as never,
    };
    orphanMessage({ data: JSON.stringify(frame) });
    second.deliver(frame);
    expect(events).toHaveLength(1);
  });

  it("an orphaned socket's onclose does not schedule a reconnect", async () => {
    const sock = createAgoraSocket(
      { url: () => "ws://test/ws", WebSocketImpl: FakeWS },
      { onEvent: () => {} },
    );
    sock.connect();
    const first = FakeWebSocket.instances[0];
    // Capture before wake nulls the property — the closure still identity-checks.
    const orphanClose = first.onclose!;
    sock.wake(); // replaces first while still CONNECTING
    expect(FakeWebSocket.instances).toHaveLength(2);

    orphanClose(null);
    await vi.runAllTimersAsync();
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Current socket closing *should* schedule reconnect.
    FakeWebSocket.instances[1].close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("wake is a no-op while the current socket is OPEN", () => {
    const sock = createAgoraSocket(
      { url: () => "ws://test/ws", WebSocketImpl: FakeWS },
      { onEvent: () => {} },
    );
    sock.connect();
    FakeWebSocket.instances[0].open();
    sock.wake();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
