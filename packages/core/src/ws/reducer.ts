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
  MessageClearEvent,
  MessageEvent,
  PinEvent,
  PinnedMessage,
  ReadEvent,
  ThreadReadEvent,
  ThreadRenamedEvent,
  ThreadRow,
  UnreadItem,
  UnreadInboxPage,
  StarredMessage,
  WsEvent,
} from "../api/types";
import { keys } from "../api/keys";
import { mentionsMe } from "../lib/unread";
import { useLive } from "../state/live";
import { draftSync } from "../state/draftSync";

export type MessagePages = InfiniteData<Message[], unknown>;

const unreadRefreshTimers = new WeakMap<QueryClient, { timer: ReturnType<typeof setTimeout>; firstAt: number }>();
const approvalRefreshTimers = new WeakMap<QueryClient, { timer: ReturnType<typeof setTimeout>; firstAt: number }>();
function refreshApprovals(qc: QueryClient) {
  const pending = approvalRefreshTimers.get(qc);
  if (pending) clearTimeout(pending.timer);
  const firstAt = pending?.firstAt ?? Date.now();
  const delay = Math.min(750, Math.max(0, 3000 - (Date.now() - firstAt)));
  const timer = setTimeout(() => {
    approvalRefreshTimers.delete(qc);
    void qc.invalidateQueries({ queryKey: keys.approvals });
  }, delay);
  approvalRefreshTimers.set(qc, { timer, firstAt });
}
function refreshUnreads(qc: QueryClient) {
  const pending = unreadRefreshTimers.get(qc);
  if (pending) clearTimeout(pending.timer);
  const firstAt = pending?.firstAt ?? Date.now();
  const delay = Math.min(750, Math.max(0, 3000 - (Date.now() - firstAt)));
  const timer = setTimeout(() => {
    unreadRefreshTimers.delete(qc);
    void qc.invalidateQueries({ queryKey: keys.unreads });
  }, delay);
  unreadRefreshTimers.set(qc, { timer, firstAt });
}

export function applyReadToUnreads(
  rows: UnreadItem[] | undefined,
  event: ReadEvent | ThreadReadEvent,
): UnreadItem[] | undefined {
  if (!rows) return undefined;
  return rows.filter(item => {
    const matches = event.type === "read"
      ? item.kind === "channel" && item.channel_id === event.channel_id
      : item.kind === "thread" && item.thread_id === event.thread_id;
    // A partial ack changes the unread count and first unread message. Drop
    // the cached card until the already-scheduled unread query can rebuild it.
    return !matches || event.last_read_id < item.first_unread_id;
  });
}

export function applyReadToUnreadPage(
  page: UnreadInboxPage | undefined,
  event: ReadEvent | ThreadReadEvent,
): UnreadInboxPage | undefined {
  if (!page) return undefined;
  const items = applyReadToUnreads(page.items, event) ?? page.items;
  return { items, total: Math.max(items.length, page.total - (page.items.length - items.length)) };
}

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
  const withMessage = [...(pages[0] ?? []), message];
  withMessage.sort((a, b) => (a.seq ?? a.id) - (b.seq ?? b.id));
  pages[0] = withMessage;
  return { ...data, pages };
}

export function moveMessage(data: MessagePages | undefined, messageId: number, seq: number): MessagePages | undefined {
  if (!data) return undefined;
  let found = false;
  const pages = data.pages.map((page) => page.map((message) => {
    if (message.id !== messageId) return message;
    found = true;
    return { ...message, seq };
  }));
  if (!found) return data;
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

/** Count a deletion once; use the server's next-latest timestamp because the
    remaining replies may not be loaded in this client's thread pages. */
export function dropReplyCount(
  data: MessagePages | undefined,
  ev: MessageDeleteEvent,
): MessagePages | undefined {
  if (!data) return undefined;
  if (!data.pages.some((p) => p.some((m) => m.id === ev.thread_id))) return data;
  return {
    ...data,
    pages: data.pages.map((p) =>
      p.map((m) => {
        if (m.id !== ev.thread_id) return m;
        const nextCount = Math.max(0, (m.reply_count ?? 0) - 1);
        return {
          ...m,
          reply_count: nextCount,
          // Use the count as a gate only. An absolute snapshot may include a
          // reply still in flight, or be stale-high after another delete.
          last_reply_ts: ev.reply_count != null && nextCount <= ev.reply_count
            ? (ev.last_reply_ts ?? undefined)
            : m.last_reply_ts,
        };
      }),
    ),
  };
}

/** A reply arrived: bump reply_count on its root in the top-level page set. */
export function bumpReplyCount(
  data: MessagePages | undefined,
  reply: Message,
): MessagePages | undefined {
  if (!data) return undefined;
  if (!data.pages.some((p) => p.some((m) => m.id === reply.thread_id))) return data;
  return {
    ...data,
    pages: data.pages.map((p) =>
      p.map((m) =>
        m.id === reply.thread_id ? {
          ...m,
          reply_count: (m.reply_count ?? 0) + 1,
          last_reply_ts: Math.max(m.last_reply_ts ?? 0, reply.ts),
        } : m,
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
        return isReply ? c : { ...c, unread: 0, last_read_id: message.id };
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
    channels: (g.channels || []).map((c) =>
      c.id === ev.channel_id
        ? { ...c, unread: ev.unread ?? 0, mentions: ev.mentions ?? c.mentions,
            last_read_id: ev.last_read_id }
        : c,
    ),
  }));
}

export function applyThreadReadToGroups(
  groups: Group[] | undefined,
  ev: ThreadReadEvent,
): Group[] | undefined {
  if (!groups || ev.mentions === undefined) return groups;
  return groups.map(g => ({
    ...g,
    channels: (g.channels || []).map(c => c.id === ev.channel_id ? { ...c, mentions: ev.mentions } : c),
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
      ? { ...t, unread: ev.unread ?? 0, last_read_id: ev.last_read_id }
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
    invalidateQueries are safe to repeat; the count and timestamp update is
    gated so a late HTTP response cannot undo a newer reply. A root takes its
    whole thread with it server-side, so its reply page and cache go too. */
export function applyMessageDelete(qc: QueryClient, ev: MessageDeleteEvent): void {
  qc.setQueryData<MessagePages>(
    keys.messages(ev.channel_id, ev.thread_id),
    (data) => removeMessage(data, ev.message_id),
  );
  if (ev.thread_id != null) {
    // The HTTP response and WS echo describe the same deletion. Apply only
    // the first to keep later reply events intact.
    const firstDelete = claimId(deletedMessageIds, qc, ev.message_id);
    if (firstDelete) {
      const next = qc.setQueryData<MessagePages>(
        keys.messages(ev.channel_id, null),
        (data) => dropReplyCount(data, ev),
      );
      const root = next?.pages.flat().find((m) => m.id === ev.thread_id);
      // A divergent server snapshot can be older or newer than the cached
      // event stream; refetch to resolve concurrent replies and deletes.
      if (root && ev.reply_count != null && root.reply_count !== ev.reply_count) {
        void qc.invalidateQueries({ queryKey: keys.messages(ev.channel_id, null) });
      }
    }
  } else {
    qc.removeQueries({ queryKey: keys.messages(ev.channel_id, ev.message_id) });
    qc.removeQueries({ queryKey: keys.message(ev.message_id) });
    void qc.invalidateQueries({ queryKey: keys.pins(ev.channel_id) });
  }
  void qc.invalidateQueries({ queryKey: keys.threads });
  void qc.invalidateQueries({ queryKey: keys.stars(ev.channel_id) });
}

const emptyPages = (data: MessagePages | undefined): MessagePages | undefined =>
  data ? { ...data, pages: [[]], pageParams: [undefined] } : data;

/** Apply a bulk history clear without replaying one event per deleted row. */
export function applyMessageClear(qc: QueryClient, ev: MessageClearEvent): void {
  if (ev.thread_id == null) {
    qc.setQueryData<MessagePages>(keys.messages(ev.channel_id, null), emptyPages);
    qc.removeQueries({
      predicate: query => query.queryKey[0] === "messages"
        && query.queryKey[1] === ev.channel_id && query.queryKey[2] !== 0,
    });
    qc.removeQueries({
      predicate: query => query.queryKey[0] === "message"
        && (query.state.data as Message | undefined)?.channel_id === ev.channel_id,
    });
    qc.setQueryData<ThreadRow[]>(keys.threads, rows =>
      rows?.filter(row => row.channel_id !== ev.channel_id),
    );
  } else {
    qc.setQueryData<MessagePages>(keys.messages(ev.channel_id, ev.thread_id), emptyPages);
    qc.setQueryData<MessagePages>(keys.messages(ev.channel_id, null), data => {
      if (!data) return data;
      return {
        ...data,
        pages: data.pages.map(page => page.map(message =>
          message.id === ev.thread_id ? { ...message, reply_count: 0, last_reply_ts: undefined } : message)),
      };
    });
    qc.setQueryData<Message>(keys.message(ev.thread_id), root =>
      root ? { ...root, reply_count: 0, last_reply_ts: undefined } : root,
    );
    qc.setQueryData<ThreadRow[]>(keys.threads, rows => rows?.map(row =>
      row.root.id === ev.thread_id
        ? { ...row, reply_count: 0, last_reply_ts: 0, unread: 0,
          root: { ...row.root, reply_count: 0, last_reply_ts: undefined } }
        : row),
    );
  }
  void qc.invalidateQueries({ queryKey: keys.pins(ev.channel_id) });
  void qc.invalidateQueries({ queryKey: keys.stars(ev.channel_id) });
  void qc.invalidateQueries({ queryKey: ["attachments", ev.channel_id] });
  void qc.invalidateQueries({ queryKey: ["search"] });
  void qc.invalidateQueries({ queryKey: keys.groups });
  void qc.invalidateQueries({ queryKey: keys.dms });
  void qc.invalidateQueries({ queryKey: keys.threads });
}

/* ------------------------------------------------------------- driver */

export interface WsContext {
  username: string;
  /** Called only for a new message frame after the reducer's id gate. */
  onMessage?: (message: Message) => void;
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
    case "draft": {
      draftSync.applyRemote(ev);
      break;
    }
    case "agent_usage": {
      const usage = ev as AgentUsageEvent;
      qc.setQueryData<AgentUsageResponse>(keys.agentUsage(usage.agent_id), (old) => ({
        ...old, usage: usage.usage, refreshing: false, stale: usage.stale ?? false,
      }));
      break;
    }
    case "message": {
      const { message } = ev as MessageEvent;
      // Duplicate frames (leaked sockets) must not re-bump reply/unread
      // counters — appendMessage already dedupes the list, but the bump
      // helpers do not.
      if (!claimId(seenMessageIds, qc, message.id)) return;
      if (message.meta?.approval_inbox) refreshApprovals(qc);
      if (!(message.author_type === "user" && message.author_id === ctx.username)) refreshUnreads(qc);
      qc.setQueryData<MessagePages>(
        keys.messages(message.channel_id, message.thread_id),
        (data) => appendMessage(data, message),
      );
      if (message.thread_id != null) {
        qc.setQueryData<MessagePages>(
          keys.messages(message.channel_id, null),
          (data) => bumpReplyCount(data, message),
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
      ctx.onMessage?.(message);
      break;
    }
    case "message_update": {
      const { message } = ev as { type: "message_update"; message: Message };
      if (message.meta && "approval_inbox" in message.meta) refreshApprovals(qc);
      applyMessageUpdate(qc, message);
      // Attachment deletion deliberately reuses message_update so every
      // message presentation is patched. Refresh any open file browsers too;
      // ordinary edits make this a cheap no-op while their queries are idle.
      void qc.invalidateQueries({ queryKey: ["attachments", message.channel_id] });
      break;
    }
    case "message_move": {
      refreshApprovals(qc);
      const queryKey = keys.messages(ev.channel_id, ev.thread_id);
      const data = qc.getQueryData<MessagePages>(queryKey);
      const next = moveMessage(data, ev.message_id, ev.seq);
      qc.setQueryData<MessagePages>(queryKey, next);
      if (data && next === data) {
        void qc.invalidateQueries({ queryKey });
      }
      break;
    }
    case "message_delete": {
      void draftSync.hydrate().catch(() => {});
      refreshApprovals(qc);
      refreshUnreads(qc);
      applyMessageDelete(qc, ev);
      void qc.invalidateQueries({ queryKey: ["attachments", ev.channel_id] });
      break;
    }
    case "message_clear": {
      void draftSync.hydrate().catch(() => {});
      refreshApprovals(qc);
      refreshUnreads(qc);
      applyMessageClear(qc, ev);
      break;
    }
    case "read": {
      const page = qc.getQueryData<UnreadInboxPage>(keys.unreads);
      if (!ev.from_post || (ev.unread ?? 0) > 0 || (page && page.total > page.items.length)) refreshUnreads(qc);
      qc.setQueryData<UnreadInboxPage>(keys.unreads, page => applyReadToUnreadPage(page, ev));
      qc.setQueryData<Group[]>(keys.groups, (groups) =>
        applyReadToGroups(groups, ev),
      );
      if (ev.mentions === undefined) void qc.invalidateQueries({ queryKey: keys.groups });
      break;
    }
    case "thread_read": {
      const page = qc.getQueryData<UnreadInboxPage>(keys.unreads);
      if (!ev.from_post || (ev.unread ?? 0) > 0 || (page && page.total > page.items.length)) refreshUnreads(qc);
      qc.setQueryData<UnreadInboxPage>(keys.unreads, page => applyReadToUnreadPage(page, ev));
      qc.setQueryData<ThreadRow[]>(keys.threads, (threads) =>
        applyThreadRead(threads, ev),
      );
      qc.setQueryData<Group[]>(keys.groups, groups => applyThreadReadToGroups(groups, ev));
      if (ev.mentions === undefined) void qc.invalidateQueries({ queryKey: keys.groups });
      break;
    }
    case "thread_renamed": {
      void draftSync.hydrate().catch(() => {});
      refreshUnreads(qc);
      refreshApprovals(qc);
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
