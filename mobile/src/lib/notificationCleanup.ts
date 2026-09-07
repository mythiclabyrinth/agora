import { notificationNumber as numeric } from "@agora/core";

export interface PresentedNotification {
  identifier: string;
  data: unknown;
}

interface ChannelReadState {
  id: string;
  unread?: number;
  last_read_id?: number;
}

interface GroupReadState {
  channels?: ChannelReadState[];
}

interface ThreadReadState {
  root: { id: number };
  unread?: number;
  last_read_id: number;
}

/** Select only delivered cards made obsolete by the user's current read state.
    Channel reads deliberately never clear thread cards. Cards without a
    message id are aggregate notifications and clear only at zero unread. */
export function obsoleteNotificationIds(
  presented: PresentedNotification[],
  groups: GroupReadState[],
  threads: ThreadReadState[],
): string[] {
  const channels = new Map(
    groups.flatMap((group) => group.channels ?? []).map((channel) => [channel.id, channel]),
  );
  const threadMap = new Map(threads.map((thread) => [thread.root.id, thread]));

  return presented.flatMap(({ identifier, data }) => {
    if (!data || typeof data !== "object") return [];
    const payload = data as Record<string, unknown>;
    // Reading a request does not answer it. Resolution is reconciled against
    // message state separately, including when another device answers it.
    if (payload.pending_interaction === true) return [];
    const channelId = typeof payload.channel_id === "string" ? payload.channel_id : null;
    const threadId = numeric(payload.thread_id);
    const messageId = numeric(payload.message_id);

    if (threadId != null) {
      const thread = threadMap.get(threadId);
      if (!thread) return [];
      const obsolete = messageId == null
        ? thread.unread === 0
        : messageId <= thread.last_read_id;
      return obsolete ? [identifier] : [];
    }

    if (!channelId) return [];
    const channel = channels.get(channelId);
    if (!channel) return [];
    const obsolete = messageId == null
      ? channel.unread === 0
      : messageId <= (channel.last_read_id ?? 0);
    return obsolete ? [identifier] : [];
  });
}

export function conversationKey(channelId: string, threadId?: number | null): string {
  return threadId == null ? `channel:${channelId}` : `thread:${threadId}`;
}
