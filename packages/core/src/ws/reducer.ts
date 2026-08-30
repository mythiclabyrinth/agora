/* Pure cache transforms for incoming /ws events. The driver (applyWsEvent)
   feeds them into the TanStack Query cache; the transforms themselves are
   plain functions so they can be unit-tested against recorded frames. */

import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type {
  Group,
  AgentUsageEvent,
  AgentUsageResponse,
  Message,
  MessageDeleteEvent,
  MessageEvent,
  PinEvent,
  PinnedMessage,
  ReadEvent,
  ThreadReadEvent,
  ThreadRenamedEvent,
  ThreadRow,
  StarredMessage,
  WsEvent,
} from "../api/types";
import { keys } from "../api/keys";
import { mentionsMe } from "../lib/unread";
import { useLive } from "../state/live";

export type MessagePages = InfiniteData<Message[], unknown>;

/** Append a message to its page set (newest page is pages[0], newest-last
    inside a page). No-op if the message is already present (e.g. our own
    POST already landed via the mutation). */
export function appendMessage(
  data: MessagePages | undefined,
  message: Message,
): MessagePages | undefined {
  if (!data) return undefined;
  if (data.pages.some((p) => p.some((m) => m.id === message.id))) return data;
  const pages = data.pages.slice();
  pages[0] = [...(pages[0] ?? []), message];
  return { ...data, pages };
}

/** Replace a message in place (e.g. options resolved). */
export function replaceMessage(
  data: MessagePages | undefined,
  message: Message,
): MessagePages | undefined {
  if (!data) return undefined;
  let found = false;
  const pages = data.pages.map((p) =>
    p.map((m) => {
      if (m.id !== message.id) return m;
      found = true;
      return { ...m, ...message, reply_count: message.reply_count ?? m.reply_count };
    }),
  );
  return found ? { ...data, pages } : data;
}

/** Patch every cached presentation of a message, including embedded thread,
    pin, and star rows whose previews would otherwise retain stale text. */
export function applyMessageUpdate(qc: QueryClient, message: Message): void {
  qc.setQueryData<MessagePages>(
    keys.messages(message.channel_id, message.thread_id),
    (data) => replaceMessage(data, message),
  );
  qc.setQueryData<Message>(keys.message(message.id), (old) =>
    old ? { ...old, ...message } : old,
  );
  qc.setQueryData<ThreadRow[]>(keys.threads, (rows) => {
    if (!rows?.some((row) => row.root.id === message.id)) return rows;
    return rows.map((row) => row.root.id === message.id
      ? { ...row, root: { ...row.root, ...message } }
      : row);
  });
  qc.setQueryData<PinnedMessage[]>(keys.pins(message.channel_id), (rows) => {
    if (!rows?.some((row) => row.id === message.id)) return rows;
    return rows.map((row) => row.id === message.id ? { ...row, ...message } : row);
  });
  qc.setQueryData<StarredMessage[]>(keys.stars(message.channel_id), (rows) => {
    if (!rows?.some((row) => row.id === message.id || row.root?.id === message.id)) return rows;
    return rows.map((row) => ({
      ...row,
      ...(row.id === message.id ? message : {}),
      root: row.root?.id === message.id ? { ...row.root, ...message } : row.root,
    }));
  });
}

/** Drop a message from its page set (deleted by its sender or an admin). */
export function removeMessage(
  data: MessagePages | undefined,
  messageId: number,
): MessagePages | undefined {
  if (!data) return undefined;
  if (!data.pages.some((p) => p.some((m) => m.id === messageId))) return data;
  return { ...data, pages: data.pages.map((p) => p.filter((m) => m.id !== messageId)) };
}

/** A reply was deleted: drop reply_count on its root in the top-level set. */
export function dropReplyCount(
  data: MessagePages | undefined,
  rootId: number,
): MessagePages | undefined {
  if (!data) return undefined;
  return {
    ...data,
    pages: data.pages.map((p) =>
      p.map((m) =>
        m.id === rootId ? { ...m, reply_count: Math.max(0, (m.reply_count ?? 0) - 1) } : m,
      ),
    ),
  };
}

/** A reply arrived: bump reply_count on its root in the top-level page set. */
export function bumpReplyCount(
  data: MessagePages | undefined,
  rootId: number,
): MessagePages | undefined {
  if (!data) return undefined;
  return {
    ...data,
    pages: data.pages.map((p) =>
      p.map((m) =>
        m.id === rootId ? { ...m, reply_count: (m.reply_count ?? 0) + 1 } : m,
      ),
    ),
  };
}

/** Unread bookkeeping on the groups payload for a new message. Own messages
    are never unread (the server also advances our marker on post). Channel
    counts track top-level messages only — thread replies badge their thread —
    but an @you anywhere bumps the channel's mention count. */
export function applyMessageToGroups(
  groups: Group[] | undefined,
  message: Message,
  username: string,
): Group[] | undefined {
  if (!groups) return undefined;
  const own = message.author_type === "user" && message.author_id === username;
  const isReply = message.thread_id != null;
  return groups.map((g) => ({
    ...g,
    channels: g.channels.map((c) => {
      if (c.id !== message.channel_id) return c;
      if (own) {
        return isReply ? c : { ...c, unread: 0, mentions: 0, last_read_id: message.id };
      }
      if (message.id <= (c.last_read_id ?? 0)) return c;
      const mention = mentionsMe(message.text, username);
      if (isReply && !mention) return c;
      return {
        ...c,
        unread: isReply ? (c.unread ?? 0) : (c.unread ?? 0) + 1,
        mentions: mention ? (c.mentions ?? 0) + 1 : (c.mentions ?? 0),
      };
    }),
  }));
}

export function applyReadToGroups(
  groups: Group[] | undefined,
  ev: ReadEvent,
): Group[] | undefined {
  if (!groups) return undefined;
  return groups.map((g) => ({
    ...g,
    channels: g.channels.map((c) =>
      c.id === ev.channel_id
        ? { ...c, unread: 0, mentions: 0, last_read_id: ev.last_read_id }
        : c,
    ),
  }));
}

/** A thread reply landed: update the inbox row (reply stats + unread).
    Returns undefined-unchanged semantics like the other transforms; if the
    thread isn't in the cache the caller refetches instead. */
export function applyReplyToThreads(
  threads: ThreadRow[] | undefined,
  message: Message,
  username: string,
): ThreadRow[] | undefined {
  if (!threads || message.thread_id == null) return threads;
  const own = message.author_type === "user" && message.author_id === username;
  const idx = threads.findIndex((t) => t.root.id === message.thread_id);
  if (idx < 0) return threads;
  const t = threads[idx];
  const updated: ThreadRow = {
    ...t,
    reply_count: t.reply_count + 1,
    last_reply_id: Math.max(t.last_reply_id, message.id),
    last_reply_ts: message.ts,
    unread: own ? t.unread : t.unread + 1,
    last_read_id: own ? Math.max(t.last_read_id, message.id) : t.last_read_id,
  };
  const out = threads.slice();
  out.splice(idx, 1);
  return [updated, ...out]; // newest activity first, like the server
}

export function applyThreadRead(
  threads: ThreadRow[] | undefined,
  ev: ThreadReadEvent,
): ThreadRow[] | undefined {
  if (!threads) return undefined;
  return threads.map((t) =>
    t.root.id === ev.thread_id && ev.last_read_id >= t.last_read_id
      ? { ...t, unread: 0, last_read_id: ev.last_read_id }
      : t,
  );
}

/** A thread was renamed: patch the alias on its inbox row's root. */
export function applyThreadRename(
  threads: ThreadRow[] | undefined,
  ev: ThreadRenamedEvent,
): ThreadRow[] | undefined {
  if (!threads) return undefined;
  return threads.map((t) =>
    t.root.id === ev.thread_id
      ? { ...t, root: { ...t.root, alias: ev.alias } }
      : t,
  );
}

/** The rename also lands on the root wherever message caches hold it: the
    channel's top-level pages and the single-message cache both feed open
    thread headers, so patching only the inbox row would leave them stale. */
export function applyAliasToPages(
  data: MessagePages | undefined,
  threadId: number,
  alias: string | null,
): MessagePages | undefined {
  if (!data) return undefined;
  let found = false;
  const pages = data.pages.map((p) =>
    p.map((m) => {
      if (m.id !== threadId) return m;
      found = true;
      return { ...m, alias };
    }),
  );
  return found ? { ...data, pages } : data;
}

/** Scrub a deleted message from every cache that may hold it. Shared by the
    WS case and useDeleteMessage's onSuccess. removeMessage / removeQueries /
    invalidateQueries are safe to repeat; only dropReplyCount is gated so the
    mutation + WS echo don't double-decrement, while the echo can still
    re-invalidate threads/stars/pins. A root takes its whole thread with it
    server-side, so its reply page set and single-message cache go too. */
export function applyMessageDelete(qc: QueryClient, ev: MessageDeleteEvent): void {
  qc.setQueryData<MessagePages>(
    keys.messages(ev.channel_id, ev.thread_id),
    (data) => removeMessage(data, ev.message_id),
  );
  if (ev.thread_id != null) {
    // dropReplyCount is the only non-idempotent step — claim just around it.
    if (claimId(deletedMessageIds, qc, ev.message_id)) {
      qc.setQueryData<MessagePages>(
        keys.messages(ev.channel_id, null),
        (data) => dropReplyCount(data, ev.thread_id!),
      );
    }
  } else {
    qc.removeQueries({ queryKey: keys.messages(ev.channel_id, ev.message_id) });
    qc.removeQueries({ queryKey: keys.message(ev.message_id) });
    void qc.invalidateQueries({ queryKey: keys.pins(ev.channel_id) });
  }
  void qc.invalidateQueries({ queryKey: keys.threads });
  void qc.invalidateQueries({ queryKey: keys.stars(ev.channel_id) });
}

/* ------------------------------------------------------------- driver */

export interface WsContext {
  username: string;
  /** Called for agent messages so the app can raise a local notification
      while backgrounded. */
  onAgentMessage?: (message: Message) => void;
}

/** Per-QueryClient sets of ids already applied via applyWsEvent /
    dropReplyCount. Message ids are claimed only inside applyWsEvent —
    never from optimistic mutation paths — so the WS echo of an own reply
    still runs bumpReplyCount. Delete ids gate only dropReplyCount so the
    mutation onSuccess + WS echo share one counter bump while invalidations
    still re-run. Caps at SEEN_CAP with FIFO eviction. */
const SEEN_CAP = 512;
const seenMessageIds = new WeakMap<QueryClient, Set<number>>();
const deletedMessageIds = new WeakMap<QueryClient, Set<number>>();

function claimId(
  map: WeakMap<QueryClient, Set<number>>,
  qc: QueryClient,
  id: number,
): boolean {
  let seen = map.get(qc);
  if (!seen) {
    seen = new Set();
    map.set(qc, seen);
  }
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > SEEN_CAP) {
    seen.delete(seen.values().next().value!);
  }
  return true;
}

/** Drop the per-client seen/deleted id sets. Call next to `QueryClient.clear()`
    on sign-out, and when the live socket reconnects against a new server —
    message ids are per-instance rowids, so a stale set silently drops real
    frames after a server switch. */
export function resetSeenMessageIds(qc: QueryClient): void {
  seenMessageIds.delete(qc);
  deletedMessageIds.delete(qc);
}

export function applyWsEvent(
  qc: QueryClient,
  ev: WsEvent,
  ctx: WsContext,
): void {
  switch (ev.type) {
    case "agent_usage": {
      const usage = ev as AgentUsageEvent;
      qc.setQueryData<AgentUsageResponse>(keys.agentUsage(usage.agent_id), (old) => ({
        ...old, usage: usage.usage, refreshing: false, stale: false,
      }));
      break;
    }
    case "message": {
      const { message } = ev as MessageEvent;
      // Duplicate frames (leaked sockets) must not re-bump reply/unread
      // counters — appendMessage already dedupes the list, but the bump
      // helpers do not.
      if (!claimId(seenMessageIds, qc, message.id)) return;
      qc.setQueryData<MessagePages>(
        keys.messages(message.channel_id, message.thread_id),
        (data) => appendMessage(data, message),
      );
      if (message.thread_id != null) {
        qc.setQueryData<MessagePages>(
          keys.messages(message.channel_id, null),
          (data) => bumpReplyCount(data, message.thread_id!),
        );
      }
      qc.setQueryData<Group[]>(keys.groups, (groups) =>
        applyMessageToGroups(groups, message, ctx.username),
      );
      if (message.thread_id != null) {
        const threads = qc.getQueryData<ThreadRow[]>(keys.threads);
        if (threads && threads.some((t) => t.root.id === message.thread_id)) {
          qc.setQueryData<ThreadRow[]>(keys.threads, (t) =>
            applyReplyToThreads(t, message, ctx.username),
          );
        } else {
          // A reply in a thread we don't have rows for (maybe newly ours) —
          // let the server decide whether it belongs in the inbox.
          void qc.invalidateQueries({ queryKey: keys.threads });
        }
      }
      if (message.author_type === "agent") {
        // The agent replied: its typing/progress rows are stale.
        useLive.getState().agentDone(message.channel_id, message.author_id);
        ctx.onAgentMessage?.(message);
      }
      break;
    }
    case "message_update": {
      const { message } = ev as { type: "message_update"; message: Message };
      applyMessageUpdate(qc, message);
      // Attachment deletion deliberately reuses message_update so every
      // message presentation is patched. Refresh any open file browsers too;
      // ordinary edits make this a cheap no-op while their queries are idle.
      void qc.invalidateQueries({ queryKey: ["attachments", message.channel_id] });
      break;
    }
    case "message_delete": {
      applyMessageDelete(qc, ev);
      void qc.invalidateQueries({ queryKey: ["attachments", ev.channel_id] });
      break;
    }
    case "read": {
      qc.setQueryData<Group[]>(keys.groups, (groups) =>
        applyReadToGroups(groups, ev),
      );
      break;
    }
    case "thread_read": {
      qc.setQueryData<ThreadRow[]>(keys.threads, (threads) =>
        applyThreadRead(threads, ev),
      );
      break;
    }
    case "thread_renamed": {
      qc.setQueryData<ThreadRow[]>(keys.threads, (threads) =>
        applyThreadRename(threads, ev),
      );
      qc.setQueryData<MessagePages>(keys.messages(ev.channel_id, null), (data) =>
        applyAliasToPages(data, ev.thread_id, ev.alias),
      );
      qc.setQueryData<Message>(keys.message(ev.thread_id), (old) =>
        old ? { ...old, alias: ev.alias } : old,
      );
      break;
    }
    case "pin": {
      const pin = ev as PinEvent;
      // Payload carries the full pin row on pin, only the id on unpin —
      // refetching keeps ordering/pin metadata authoritative.
      void qc.invalidateQueries({ queryKey: keys.pins(pin.channel_id) });
      break;
    }
    case "typing": {
      useLive.getState().onTyping(ev);
      break;
    }
    case "progress": {
      useLive.getState().onProgress(ev);
      break;
    }
  }
}
