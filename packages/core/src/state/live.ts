/* Ephemeral per-channel activity (typing + progress bubbles). These are
   transient WS frames, never persisted, so they live outside the query
   cache. Mirrors hub.rs record_activity: a typing=false frame (or the
   agent's actual reply) clears that agent's typing row and progress lines. */

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { ProgressEvent, TypingEvent, ChannelActivity, AllActivity } from "../api/types";

interface LiveState {
  /** channel_id -> agent_id -> typing frame */
  typing: Record<string, Record<string, TypingEvent>>;
  /** channel_id -> handle -> progress frame */
  progress: Record<string, Record<string, ProgressEvent>>;
  epoch: number;
  /** channel_id:agent_id -> last WS update epoch */
  touched: Record<string, number>;
  onTyping: (ev: TypingEvent) => void;
  onProgress: (ev: ProgressEvent) => void;
  agentDone: (channelId: string, agentId: string) => void;
  /** Seed from GET /api/channels/{id}/activity when opening a channel. */
  seed: (channelId: string, activity: ChannelActivity) => void;
  seedAll: (snapshot: AllActivity, startEpoch: number) => void;
}

export const useLive = create<LiveState>((set) => ({
  typing: {},
  progress: {},
  epoch: 0,
  touched: {},

  onTyping(ev) {
    set((s) => {
      if (ev.active) {
        return {
          ...touchAgent(s, ev.channel_id, ev.agent_id),
          typing: {
            ...s.typing,
            [ev.channel_id]: { ...s.typing[ev.channel_id], [ev.agent_id]: ev },
          },
        };
      }
      return { ...clearAgent(s, ev.channel_id, ev.agent_id), ...touchAgent(s, ev.channel_id, ev.agent_id) };
    });
  },

  onProgress(ev) {
    set((s) => ({
      ...touchAgent(s, ev.channel_id, ev.agent_id),
      progress: {
        ...s.progress,
        [ev.channel_id]: { ...s.progress[ev.channel_id], [ev.handle]: ev },
      },
    }));
  },

  agentDone(channelId, agentId) {
    set((s) => ({ ...clearAgent(s, channelId, agentId), ...touchAgent(s, channelId, agentId) }));
  },

  seed(channelId, activity) {
    set((s) => ({
      typing: {
        ...s.typing,
        [channelId]: Object.fromEntries(
          activity.typing.map((t) => [t.agent_id, t]),
        ),
      },
      progress: {
        ...s.progress,
        [channelId]: Object.fromEntries(
          activity.progress.map((p) => [p.handle, p]),
        ),
      },
    }));
  },

  seedAll(snapshot, startEpoch) {
    set((s) => {
      const typing: LiveState["typing"] = {};
      const progress: LiveState["progress"] = {};
      for (const [channelId, activity] of Object.entries(snapshot.channels)) {
        typing[channelId] = Object.fromEntries(activity.typing.map(t => [t.agent_id, t]));
        progress[channelId] = Object.fromEntries(activity.progress.map(p => [p.handle, p]));
      }
      const touched: LiveState["touched"] = {};
      for (const [key, epoch] of Object.entries(s.touched)) {
        if (epoch <= startEpoch) continue;
        touched[key] = epoch;
        const separator = key.indexOf(":");
        const channelId = key.slice(0, separator);
        const agentId = key.slice(separator + 1);
        const channelTyping = { ...typing[channelId] };
        delete channelTyping[agentId];
        const currentTyping = s.typing[channelId]?.[agentId];
        if (currentTyping) channelTyping[agentId] = currentTyping;
        typing[channelId] = channelTyping;
        const channelProgress = Object.fromEntries(
          Object.entries(progress[channelId] ?? {}).filter(([, ev]) => ev.agent_id !== agentId),
        );
        for (const [handle, ev] of Object.entries(s.progress[channelId] ?? {})) {
          if (ev.agent_id === agentId) channelProgress[handle] = ev;
        }
        progress[channelId] = channelProgress;
      }
      return { typing, progress, touched };
    });
  },
}));

export function replyingNames(
  typing?: Record<string, TypingEvent>,
  progress?: Record<string, ProgressEvent>,
): string[] {
  const agents = new Map<string, string>();
  for (const event of [...Object.values(typing ?? {}), ...Object.values(progress ?? {})]) {
    if (event.thread_id == null) agents.set(event.agent_id, event.agent_name);
  }
  return [...agents.values()].sort();
}

export function useChannelReplying(channelId: string): string[] {
  const typing = useLive(s => s.typing[channelId]);
  const progress = useLive(s => s.progress[channelId]);
  return replyingNames(typing, progress);
}

/** Keep list consumers stable while text-only progress frames arrive. */
export function replyingChannelIds(s: Pick<LiveState, "typing" | "progress">): string[] {
  const ids = new Set([...Object.keys(s.typing), ...Object.keys(s.progress)]);
  return [...ids].filter(id => replyingNames(s.typing[id], s.progress[id]).length > 0).sort();
}

export function useReplyingChannelIds(): string[] {
  return useLive(useShallow(replyingChannelIds));
}

export function useGroupReplying(channelIds: string[]): string[] {
  const typing = useLive(s => s.typing);
  const progress = useLive(s => s.progress);
  const names = new Set<string>();
  for (const id of channelIds) {
    for (const name of replyingNames(typing[id], progress[id])) names.add(name);
  }
  return [...names].sort();
}

function touchAgent(s: Pick<LiveState, "epoch" | "touched">, channelId: string, agentId: string) {
  const epoch = s.epoch + 1;
  return { epoch, touched: { ...s.touched, [`${channelId}:${agentId}`]: epoch } };
}

function clearAgent(
  s: Pick<LiveState, "typing" | "progress">,
  channelId: string,
  agentId: string,
) {
  const typing = { ...(s.typing[channelId] ?? {}) };
  delete typing[agentId];
  const progress = Object.fromEntries(
    Object.entries(s.progress[channelId] ?? {}).filter(
      ([, ev]) => ev.agent_id !== agentId,
    ),
  );
  return {
    typing: { ...s.typing, [channelId]: typing },
    progress: { ...s.progress, [channelId]: progress },
  };
}

/** Typing + progress scoped to one view (top level or one thread). */
export function useChannelLive(channelId: string, threadId: number | null) {
  const typing = useLive((s) => s.typing[channelId]);
  const progress = useLive((s) => s.progress[channelId]);
  const inScope = (tid: number | null | undefined) =>
    (tid ?? null) === threadId;
  return {
    typing: Object.values(typing ?? {}).filter((t) => inScope(t.thread_id)),
    progress: Object.values(progress ?? {}).filter((p) =>
      inScope(p.thread_id),
    ),
  };
}
