import type { Message } from "../api/types";

const CONVERSATION_GAP_MS = 5_000;
const GLOBAL_GAP_MS = 1_000;

export interface ChimeState {
  lastByConversation: Map<string, number>;
  lastPlayedAt: number | null;
}

export function initialChimeState(): ChimeState {
  return { lastByConversation: new Map(), lastPlayedAt: null };
}

/** Decide from one newly accepted WS message, independent of sound playback. */
export function shouldChime(
  state: ChimeState, message: Message, username: string, now: number,
): { state: ChimeState; play: boolean } {
  if (message.author_type === "user" && message.author_id === username) {
    return { state, play: false };
  }
  const key = message.thread_id == null
    ? `channel:${message.channel_id}`
    : `thread:${message.thread_id}`;
  const previous = state.lastByConversation.get(key);
  const lastByConversation = new Map(state.lastByConversation);
  for (const [conversation, at] of lastByConversation) {
    if (now - at >= CONVERSATION_GAP_MS) lastByConversation.delete(conversation);
  }
  const play = (previous == null || now - previous >= CONVERSATION_GAP_MS)
    && (state.lastPlayedAt == null || now - state.lastPlayedAt >= GLOBAL_GAP_MS);
  // The chime intentionally slides through a burst; native banners use a fixed per-channel window.
  // A conversation blocked by the global gap can chime on its next message.
  // Once it has chimed, every message extends that conversation's quiet window.
  if (play || (previous != null && now - previous < CONVERSATION_GAP_MS)) {
    lastByConversation.set(key, now);
  }
  return {
    state: { lastByConversation, lastPlayedAt: play ? now : state.lastPlayedAt },
    play,
  };
}
