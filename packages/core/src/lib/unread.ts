/* Pure unread bookkeeping shared by the badge, the background poller and
   the notification-tap router. No Expo imports so tests stay plain. */

import type { Group, ThreadRow } from "../api/types";

/** One channel's unread state, flattened out of the groups payload. */
export interface ChannelUnread {
  id: string;
  name: string;
  group: string;
  unread: number;
  mentions: number;
}

export function unreadChannels(groups: Group[]): ChannelUnread[] {
  return groups.flatMap((g) =>
    g.channels.map((c) => ({
      id: c.id,
      name: c.name,
      group: g.name,
      unread: c.unread ?? 0,
      mentions: c.mentions ?? 0,
    })),
  );
}

export function totalUnread(groups: Group[]): number {
  return unreadChannels(groups).reduce((n, c) => n + c.unread, 0);
}

export function totalMentions(groups: Group[]): number {
  return unreadChannels(groups).reduce((n, c) => n + c.mentions, 0);
}

export function totalThreadUnread(threads: ThreadRow[]): number {
  return threads.reduce((n, t) => n + (t.unread || 0), 0);
}

/** Does `text` @mention `username`? Mirrors the server's mention_tokens:
    trailing `.`, `-` and `_` are trimmed, so `@tom.` mentions `tom`. */
export function mentionsMe(text: string, username: string): boolean {
  if (!username) return false;
  const me = username.toLowerCase();
  const re = /(^|[\s(>])@([A-Za-z0-9][\w.-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text || ""))) {
    let token = m[2].toLowerCase();
    while (token !== me && /[._-]$/.test(token)) token = token.slice(0, -1);
    if (token === me) return true;
  }
  return false;
}

/** channel_id -> unread state, persisted between background polls. Older
    installs stored a bare number (unread count); accept both. */
export type UnreadSnapshot = Record<string, number | { u: number; m: number }>;

function snapUnread(v: number | { u: number; m: number } | undefined): number {
  if (v === undefined) return 0;
  return typeof v === "number" ? v : v.u;
}
function snapMentions(v: number | { u: number; m: number } | undefined): number {
  return typeof v === "object" && v !== null ? v.m : 0;
}

export function snapshotOf(channels: ChannelUnread[]): UnreadSnapshot {
  return Object.fromEntries(channels.map((c) => [c.id, { u: c.unread, m: c.mentions }]));
}

/** What a channel banner should say (and whether it's a mention alert). */
export interface ChannelNotice {
  channel: ChannelUnread;
  newCount: number;
  newMentions: number;
}

/** Channels worth a banner: unread or mention count grew since the snapshot.
    Mentions are checked separately so an @you inside a thread (which doesn't
    move the channel count) still fires. A missing snapshot is a first run —
    baseline silently rather than replaying history as "new". Reads (counts
    dropping, here or on another device) never notify. */
export function channelsToNotify(
  prev: UnreadSnapshot | null,
  next: ChannelUnread[],
): ChannelNotice[] {
  if (!prev) return [];
  return next
    .map((c) => ({
      channel: c,
      newCount: c.unread - snapUnread(prev[c.id]),
      newMentions: c.mentions - snapMentions(prev[c.id]),
    }))
    .filter((n) => n.newCount > 0 || n.newMentions > 0);
}

/** Where a notification tap should land, from its data payload. */
export function notificationTarget(data: unknown): string | null {
  const d = data as { channel_id?: unknown; thread_id?: unknown } | null;
  if (!d || typeof d.channel_id !== "string" || !d.channel_id) return null;
  if (typeof d.thread_id === "number") {
    return `/thread/${d.channel_id}/${d.thread_id}`;
  }
  return `/channel/${d.channel_id}`;
}
