/* Framework-free live-socket lifecycle shared by web and mobile hooks.
   Identity-guards every handler so an orphaned socket (replaced on wake
   while CONNECTING/CLOSING) cannot deliver frames or schedule reconnects.
   Platform wake signals (AppState / visibilitychange / online) and the URL
   builder stay with the callers; inject WebSocketImpl in tests. */

import type { WsEvent } from "../api/types";

const BACKOFF_START = 1000;
const BACKOFF_CAP = 30_000;

/** Minimal surface the lifecycle needs — real WebSocket or a test double. */
export interface AgoraWebSocket {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  close: () => void;
}

export interface AgoraWebSocketConstructor {
  new (url: string): AgoraWebSocket;
  readonly OPEN: number;
  readonly CONNECTING: number;
  readonly CLOSING: number;
  readonly CLOSED: number;
}

export interface AgoraSocketHandlers {
  onEvent: (ev: WsEvent) => void;
  onConnectedChange?: (connected: boolean) => void;
  /** Fired on open after the first successful connection (gap heal). */
  onReopen?: () => void;
}

export interface AgoraSocketOptions {
  url: () => string;
  WebSocketImpl?: AgoraWebSocketConstructor;
  backoffStart?: number;
  backoffCap?: number;
  /** Injectable timer seams for tests. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
}

export interface AgoraSocket {
  connect: () => void;
  /** Reconnect unless the current socket is already OPEN. */
  wake: () => void;
  /** Permanent teardown — no further reconnects. */
  close: () => void;
  /** Test seam: the socket currently owned by this lifecycle. */
  current: () => AgoraWebSocket | null;
}

function defaultWebSocket(): AgoraWebSocketConstructor {
  if (typeof WebSocket === "undefined") {
    throw new Error("WebSocket is not available in this environment");
  }
  return WebSocket as unknown as AgoraWebSocketConstructor;
}

export function createAgoraSocket(
  options: AgoraSocketOptions,
  handlers: AgoraSocketHandlers,
): AgoraSocket {
  const WS = options.WebSocketImpl ?? defaultWebSocket();
  const backoffStart = options.backoffStart ?? BACKOFF_START;
  const backoffCap = options.backoffCap ?? BACKOFF_CAP;
  const schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> =
    options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const unschedule: (id: ReturnType<typeof setTimeout>) => void =
    options.clearTimer ?? ((id) => clearTimeout(id));

  let ws: AgoraWebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let backoff = backoffStart;
  let closed = false;
  let everConnected = false;

  const clearReconnectTimer = () => {
    if (timer == null) return;
    unschedule(timer);
    timer = null;
  };

  const discard = (socket: AgoraWebSocket) => {
    // Nulling is hygiene (drops the closure over handlers); the identity
    // guard below is what stops races when close() fires onclose async.
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  };

  const connect = () => {
    if (closed) return;
    clearReconnectTimer();
    if (ws) {
      const old = ws;
      ws = null;
      // discard() nulls onclose, so a CLOSING socket never reports its
      // disconnect — flip connected here the way close() does.
      discard(old);
      handlers.onConnectedChange?.(false);
    }
    let socket: AgoraWebSocket;
    try {
      socket = new WS(options.url());
    } catch {
      // Construction can throw on a malformed URL. We've already discarded
      // any prior socket, so without a retry the lifecycle is dead until
      // the next wake — schedule the normal backoff reconnect.
      if (closed) return;
      handlers.onConnectedChange?.(false);
      timer = schedule(connect, backoff);
      backoff = Math.min(backoff * 2, backoffCap);
      return;
    }
    ws = socket;

    socket.onopen = () => {
      if (ws !== socket || closed) return;
      backoff = backoffStart;
      handlers.onConnectedChange?.(true);
      if (everConnected) handlers.onReopen?.();
      everConnected = true;
    };

    socket.onmessage = (e) => {
      if (ws !== socket || closed) return;
      let ev: WsEvent;
      try {
        ev = JSON.parse(String(e.data));
      } catch {
        return;
      }
      handlers.onEvent(ev);
    };

    socket.onerror = () => {
      /* onclose follows; reconnect happens there */
    };

    socket.onclose = () => {
      // Orphaned sockets must not schedule reconnects.
      if (ws !== socket) return;
      ws = null;
      handlers.onConnectedChange?.(false);
      if (closed) return;
      timer = schedule(connect, backoff);
      backoff = Math.min(backoff * 2, backoffCap);
    };
  };

  const wake = () => {
    if (closed) return;
    // Intentionally leave a readyState===OPEN socket alone — replacing a
    // stale-but-OPEN socket after iOS foreground is a separate connectivity
    // bug, not the badge-inflation fix.
    if (ws && ws.readyState === WS.OPEN) return;
    clearReconnectTimer();
    backoff = backoffStart;
    connect();
  };

  const close = () => {
    closed = true;
    clearReconnectTimer();
    if (ws) {
      const old = ws;
      ws = null;
      discard(old);
    }
    handlers.onConnectedChange?.(false);
  };

  return { connect, wake, close, current: () => ws };
}
