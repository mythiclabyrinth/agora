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

  it("close() schedules no further reconnects", async () => {
    const sock = createAgoraSocket(
      { url: () => "ws://test/ws", WebSocketImpl: FakeWS },
      { onEvent: () => {} },
    );
    sock.connect();
    FakeWebSocket.instances[0].open();
    sock.close();
    // Closing the live socket (or a late onclose) must not reconnect.
    FakeWebSocket.instances[0].close();
    await vi.runAllTimersAsync();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(sock.current()).toBeNull();
  });

  it("onReopen fires only from the second successful open onward", async () => {
    const reopens: number[] = [];
    const sock = createAgoraSocket(
      { url: () => "ws://test/ws", WebSocketImpl: FakeWS },
      { onEvent: () => {}, onReopen: () => reopens.push(1) },
    );
    sock.connect();
    FakeWebSocket.instances[0].open();
    expect(reopens).toHaveLength(0);

    FakeWebSocket.instances[0].close();
    // FakeWebSocket.close fires onclose via microtask; flush it so the
    // reconnect timer is scheduled before we advance fake timers.
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].open();
    expect(reopens).toHaveLength(1);
  });

  it("connect() reports disconnected when replacing a CLOSING socket", () => {
    const states: boolean[] = [];
    const sock = createAgoraSocket(
      { url: () => "ws://test/ws", WebSocketImpl: FakeWS },
      { onEvent: () => {}, onConnectedChange: (c) => states.push(c) },
    );
    sock.connect();
    FakeWebSocket.instances[0].open();
    expect(states).toEqual([true]);

    // CLOSING without onclose yet — the race wake() hits after a drop.
    FakeWebSocket.instances[0].readyState = FakeWebSocket.CLOSING;
    sock.wake();
    expect(states).toEqual([true, false]);
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.instances[1].open();
    expect(states).toEqual([true, false, true]);
  });

  it("a throwing WebSocket constructor reschedules on backoff", async () => {
    let builds = 0;
    class BoomWS implements AgoraWebSocket {
      static OPEN = 1;
      static CONNECTING = 0;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = BoomWS.CONNECTING;
      onopen: AgoraWebSocket["onopen"] = null;
      onmessage: AgoraWebSocket["onmessage"] = null;
      onerror: AgoraWebSocket["onerror"] = null;
      onclose: AgoraWebSocket["onclose"] = null;
      constructor(_url: string) {
        builds++;
        throw new Error("bad url");
      }
      close() {}
    }
    const sock = createAgoraSocket(
      { url: () => "ws://bad", WebSocketImpl: BoomWS as unknown as AgoraWebSocketConstructor },
      { onEvent: () => {} },
    );
    sock.connect();
    expect(builds).toBe(1);
    expect(sock.current()).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(builds).toBe(2);
    sock.close();
    await vi.runAllTimersAsync();
    expect(builds).toBe(2);
  });
});
