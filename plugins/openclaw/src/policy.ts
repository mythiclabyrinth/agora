import { isSenderAllowed, type ResolvedAgoraAccount } from "./config.ts";
import { normalizeThreadId, type AgoraInboundFrame } from "./protocol.ts";

export type InboundDecision =
  | { handle: true }
  | { handle: false; reason: string };

const SKIP = (reason: string): InboundDecision => ({ handle: false, reason });

/**
 * Everything that decides whether an Agora message reaches the agent, in one
 * pure function so the rules can be read and tested without a socket.
 */
export function decideInbound(params: {
  frame: AgoraInboundFrame;
  account: ResolvedAgoraAccount;
  hasMedia?: boolean;
}): InboundDecision {
  const { frame, account } = params;
  const author = frame.author ?? {};
  const authorType = author.type ?? "user";
  const senderId = String(author.id ?? "");

  if (authorType !== "user") {
    // Agent-authored turns are context, not instructions. Admitting them by
    // default would make any bot in the room an execution path into this host.
    if (!account.contextFeed) return SKIP("agent-authored message");
    if (!frame.mentioned) return SKIP("agent-authored message without a mention");
    if ((frame.bot_turns_left ?? 0) < 1) return SKIP("bot loop budget exhausted");
  } else if (!isSenderAllowed(account, senderId)) {
    return SKIP(`sender ${senderId || "(unknown)"} is not on the allowlist`);
  }

  if (account.requireMention && !frame.mentioned) return SKIP("no mention");
  // Floor is closed: another agent was tagged, and/or the sender's
  // require_agent toggle closed it without a tag. Same outcome either way.
  if (frame.any_mention && !frame.mentioned) return SKIP("floor closed");

  if (!frame.text?.trim() && !params.hasMedia) return SKIP("empty message");
  return { handle: true };
}

export type AgoraRoute = {
  /** Outbound target understood by this channel's send path. */
  to: string;
  channelId: string;
  threadId: number | null;
  /** Threads are their own conversation; they must never share a session. */
  conversationId: string;
  chatType: "channel" | "thread";
};

/**
 * A channel root and each of its threads are separate conversations. Collapsing
 * them would let a thread reply land in the channel and mix two transcripts.
 */
export function resolveRoute(frame: AgoraInboundFrame): AgoraRoute {
  const channelId = String(frame.channel_id);
  const threadId = normalizeThreadId(frame.thread_id);
  return {
    to: channelId,
    channelId,
    threadId,
    conversationId: threadId === null ? channelId : `${channelId}:${threadId}`,
    chatType: threadId === null ? "channel" : "thread",
  };
}

/** Parse a conversation id produced by `resolveRoute` back into its parts. */
export function parseConversationId(conversationId: string): {
  channelId: string;
  threadId: number | null;
} {
  const separator = conversationId.lastIndexOf(":");
  if (separator <= 0) return { channelId: conversationId, threadId: null };
  const threadId = normalizeThreadId(conversationId.slice(separator + 1));
  return threadId === null
    ? { channelId: conversationId, threadId: null }
    : { channelId: conversationId.slice(0, separator), threadId };
}
