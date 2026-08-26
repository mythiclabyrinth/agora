/**
 * Agora's dial-in agent protocol, as documented in docs/PROTOCOL.md of the
 * Agora repository. Only the subset this channel needs is modelled here.
 */

/** Agent identity announced in the `hello` frame after connecting. */
export type AgoraAgentDescriptor = {
  id: string;
  name: string;
  requires_mention?: boolean;
  wants_context_feed?: boolean;
  bot_loop_limit?: number | string;
  avatar?: { mime: string; data: string };
};

/** Attachment as it arrives on an inbound frame. */
export type AgoraInboundAttachment = {
  /** Present when the file is still fetchable through `/agent/files/{id}`. */
  id?: string | number;
  filename?: string;
  mime?: string;
  size?: number;
  /** Inline bytes, present only for attachments up to 8 MB. */
  data_b64?: string;
};

/** Author of an inbound message: a human account or another agent. */
export type AgoraAuthor = {
  id?: string;
  name?: string;
  type?: "user" | "agent" | string;
};

export type AgoraInboundFrame = {
  type: "inbound";
  agent_id: string;
  channel_id: string | number;
  thread_id?: string | number | null;
  message_id?: string | number;
  chat_name?: string;
  text?: string;
  author?: AgoraAuthor;
  /** This message @mentions *this* agent. */
  mentioned?: boolean;
  /** This message @mentions *some* member agent (this one or another). */
  any_mention?: boolean;
  /** Thread composer closed the floor without requiring a real @tag.
   *  Observability only — `any_mention` already encodes the closed floor;
   *  the skip reason does not branch on this. */
  require_agent?: boolean;
  from_bot?: boolean;
  /** Agent-authored frames only: how many further agent turns the hub relays. */
  bot_turns_left?: number;
  attachments?: AgoraInboundAttachment[];
};

/** Correlated rejection for a write frame the hub refused. */
export type AgoraErrorFrame = {
  type: "error";
  frame_type?: string;
  request_id?: string;
  agent_id?: string;
  channel_id?: string | number;
  thread_id?: string | number | null;
  error?: string;
};

export type AgoraOutboundAttachment = {
  filename: string;
  mime: string;
  data_b64: string;
};

export type AgoraPostFrame = {
  type: "post";
  request_id: string;
  agent_id: string;
  channel_id: string;
  thread_id: number | null;
  text: string;
  attachments?: AgoraOutboundAttachment[];
};

export type AgoraTypingFrame = {
  type: "typing";
  agent_id: string;
  channel_id: string;
  thread_id: number | null;
  active: boolean;
};

export type AgoraReactionFrame = {
  type: "reaction";
  agent_id: string;
  channel_id: string;
  message_id: number;
  emoji: string;
  action: "add" | "remove";
};

export type AgoraOutboundFrame =
  | { type: "hello"; agents: AgoraAgentDescriptor[] }
  | AgoraPostFrame
  | AgoraTypingFrame
  | AgoraReactionFrame;

/** A frame Agora sends us. Unknown frame types are ignored by the client. */
export type AgoraServerFrame = AgoraInboundFrame | AgoraErrorFrame | { type: string };

export function isInboundFrame(frame: AgoraServerFrame): frame is AgoraInboundFrame {
  return frame.type === "inbound";
}

export function isErrorFrame(frame: AgoraServerFrame): frame is AgoraErrorFrame {
  return frame.type === "error";
}

/**
 * Agora keys threads by integer id. Anything unparseable is treated as the
 * channel root rather than guessed at, so a reply can never land in the wrong
 * thread.
 */
export function normalizeThreadId(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  const raw = String(value);
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Agora message ids are integers; reactions are dropped for anything else. */
export function normalizeMessageId(value: unknown): number | null {
  return normalizeThreadId(value);
}
