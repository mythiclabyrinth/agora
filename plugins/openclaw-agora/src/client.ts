import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  isErrorFrame,
  isInboundFrame,
  normalizeMessageId,
  type AgoraErrorFrame,
  type AgoraInboundFrame,
  type AgoraOutboundAttachment,
  type AgoraOutboundFrame,
  type AgoraServerFrame,
} from "./protocol.ts";
import { redactSocketUrl } from "./url.ts";

export type AgoraClientOptions = {
  socketUrl: string;
  agentId: string;
  agentName: string;
  requireMention: boolean;
  contextFeed: boolean;
  onInbound: (frame: AgoraInboundFrame) => void | Promise<void>;
  onConnected?: () => void;
  onDisconnected?: (reason: string) => void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  /**
   * How long a `post` waits for a correlated rejection before it is reported
   * as delivered. Agora never acks success, so this window is the only thing
   * standing between a refused post and silent message loss.
   */
  ackGraceMs?: number;
  createSocket?: (url: string) => WebSocket;
};

const DEFAULT_ACK_GRACE_MS = 600;
const BASE_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
/** Matches the hub's own 64 MB wire cap; a larger frame kills the connection. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

type PendingPost = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class AgoraClient {
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, PendingPost>();
  private readonly typing = new Set<string>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stopped = false;

  constructor(private readonly options: AgoraClientOptions) {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    await this.clearAllTyping();
    this.failPending("agora channel stopped");
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private open(): void {
    const create = this.options.createSocket ?? ((url: string) => new WebSocket(url, { maxPayload: MAX_FRAME_BYTES }));
    let socket: WebSocket;
    try {
      socket = create(this.options.socketUrl);
    } catch (error) {
      this.scheduleReconnect(String(error));
      return;
    }
    this.socket = socket;

    socket.on("open", () => {
      this.attempt = 0;
      // Registration does not survive a reconnect: the hub forgets the roster
      // when the socket drops, so hello has to be the first frame every time.
      this.send({
        type: "hello",
        agents: [
          {
            id: this.options.agentId,
            name: this.options.agentName,
            requires_mention: this.options.requireMention,
            wants_context_feed: this.options.contextFeed,
          },
        ],
      }).catch(error => this.options.warn?.(`agora: hello failed: ${String(error)}`));
      this.options.log?.(`agora: connected to ${redactSocketUrl(this.options.socketUrl)}`);
      this.options.onConnected?.();
    });

    socket.on("message", data => {
      void this.handleFrame(String(data));
    });

    socket.on("error", error => {
      this.options.warn?.(
        `agora: socket error on ${redactSocketUrl(this.options.socketUrl)}: ${String(error)}`,
      );
    });

    socket.on("close", (code, reason) => {
      this.socket = null;
      this.typing.clear();
      this.failPending(`agora connection closed (${code})`);
      this.options.onDisconnected?.(reason.toString() || String(code));
      this.scheduleReconnect(`closed with ${code}`);
    });
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.reconnectTimer) return;
    this.attempt += 1;
    const backoff = Math.min(BASE_RECONNECT_MS * 2 ** (this.attempt - 1), MAX_RECONNECT_MS);
    const delay = Math.round(backoff * (0.5 + Math.random() / 2));
    this.options.warn?.(`agora: reconnecting in ${delay}ms (${reason})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.open();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async handleFrame(raw: string): Promise<void> {
    let frame: AgoraServerFrame;
    try {
      frame = JSON.parse(raw) as AgoraServerFrame;
    } catch {
      this.options.warn?.("agora: dropped an unparseable frame");
      return;
    }
    if (isErrorFrame(frame)) {
      this.settleError(frame);
      return;
    }
    if (!isInboundFrame(frame)) return;
    try {
      await this.options.onInbound(frame);
    } catch (error) {
      this.options.warn?.(`agora: inbound handler failed: ${String(error)}`);
    }
  }

  private settleError(frame: AgoraErrorFrame): void {
    const message = frame.error || "Agora rejected the frame";
    const requestId = frame.request_id;
    const pending = requestId ? this.pending.get(requestId) : undefined;
    if (!pending) {
      this.options.warn?.(
        `agora: rejected ${frame.frame_type ?? "frame"} ${requestId ?? "(uncorrelated)"}: ${message}`,
      );
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(requestId!);
    pending.reject(new Error(message));
  }

  private failPending(reason: string): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.reject(new Error(reason));
    }
  }

  private async send(frame: AgoraOutboundFrame): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("agora: not connected");
    }
    const payload = JSON.stringify(frame);
    if (Buffer.byteLength(payload) > MAX_FRAME_BYTES) {
      // Over the wire limit the hub drops the connection before it can send a
      // correlated error, so refuse locally where the message is still visible.
      throw new Error("agora: frame exceeds the WebSocket size limit");
    }
    await new Promise<void>((resolve, reject) => {
      socket.send(payload, error => (error ? reject(error) : resolve()));
    });
  }

  /**
   * Post a message. Resolves with the request id once the ack grace window has
   * passed without a rejection; rejects if Agora refuses the frame.
   */
  async post(params: {
    channelId: string;
    threadId: number | null;
    text: string;
    attachments?: AgoraOutboundAttachment[];
  }): Promise<string> {
    const requestId = randomUUID();
    const graceMs = this.options.ackGraceMs ?? DEFAULT_ACK_GRACE_MS;
    // Registered before the frame goes out: a rejection can arrive as soon as
    // the hub reads it, and an unregistered request id would be uncorrelated.
    const settled = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve();
      }, graceMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer });
    });
    try {
      await this.send({
        type: "post",
        request_id: requestId,
        agent_id: this.options.agentId,
        channel_id: params.channelId,
        thread_id: params.threadId,
        text: params.text,
        ...(params.attachments?.length ? { attachments: params.attachments } : {}),
      });
    } catch (error) {
      const pending = this.pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.resolve();
      }
      throw error;
    }
    await settled;
    return requestId;
  }

  private typingKey(channelId: string, threadId: number | null): string {
    return `${channelId}:${threadId ?? ""}`;
  }

  async setTyping(channelId: string, threadId: number | null, active: boolean): Promise<void> {
    const key = this.typingKey(channelId, threadId);
    if (active) this.typing.add(key);
    else this.typing.delete(key);
    try {
      await this.send({
        type: "typing",
        agent_id: this.options.agentId,
        channel_id: channelId,
        thread_id: threadId,
        active,
      });
    } catch (error) {
      // Typing is best effort; a failure here must not sink the reply.
      this.options.warn?.(`agora: typing update failed: ${String(error)}`);
    }
  }

  /** Leaving a typing indicator running forever is worse than never sending one. */
  private async clearAllTyping(): Promise<void> {
    for (const key of [...this.typing]) {
      const separator = key.lastIndexOf(":");
      const channelId = key.slice(0, separator);
      const thread = key.slice(separator + 1);
      await this.setTyping(channelId, thread ? Number(thread) : null, false);
    }
    this.typing.clear();
  }

  async react(params: {
    channelId: string;
    messageId: unknown;
    emoji: string;
    action: "add" | "remove";
  }): Promise<void> {
    const messageId = normalizeMessageId(params.messageId);
    if (messageId === null) return;
    try {
      await this.send({
        type: "reaction",
        agent_id: this.options.agentId,
        channel_id: params.channelId,
        message_id: messageId,
        emoji: params.emoji,
        action: params.action,
      });
    } catch (error) {
      this.options.warn?.(`agora: reaction failed: ${String(error)}`);
    }
  }
}
