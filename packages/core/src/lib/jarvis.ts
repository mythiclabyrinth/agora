/* Jarvis mode client: the Agora assistant's streaming turn endpoint
   (POST /api/jarvis/turn, Server-Sent Events) and the draft edit/confirm/
   cancel calls. Shapes mirror crates/agora-core/src/jarvis.rs. */

import { ApiClient, authHeaders, parseError, type Session } from "../api/client";
import type { Message, Schedule, ScheduleSpec, ScheduleStatus } from "../api/types";

/** Server-side phases; the client adds `idle`, `armed`, and `error`. */
export type JarvisServerPhase = "thinking" | "searching" | "weaving" | "composing" | "waiting" | "speaking";

export interface JarvisDigestItem {
  channel_id: string;
  channel_name: string;
  group_id: string;
  group_name: string;
  thread_id: number | null;
  thread_title?: string | null;
  gist: string;
  needs_you: boolean;
  unread: number;
  mentions: number;
}

export interface JarvisMessageHit {
  id: number;
  channel_id: string;
  channel_name: string;
  group_id: string;
  group_name: string;
  thread_id: number | null;
  author?: string | null;
  text: string;
  ts: number;
}

export interface JarvisMention {
  kind: "agent" | "user";
  id: string;
  name: string;
  handle: string;
}

/** A schedule as Jarvis lists it: the server's decorated schedule. */
export type JarvisScheduleItem = Schedule;

/** A new schedule for the user to confirm (nothing is stored until they do). */
export interface JarvisScheduleDraftCard {
  kind: "schedule_draft";
  draft_id: string;
  revision: number;
  channel_id: string;
  channel_name: string;
  group_id: string;
  group_name: string;
  thread_id: number | null;
  destination: string;
  text: string;
  final_text: string;
  mentions: JarvisMention[];
  /** As stored: a cron rule is in UTC (converted from the user's local time). */
  schedule: ScheduleSpec;
  run_at: number;
  next_runs: number[];
  /** Set when the user's zone observes daylight saving and a UTC cron rule will drift. */
  dst_note: string | null;
  /** Set when the local time given fell in a clock change (skipped or repeated). */
  time_note?: string | null;
  expires_in: number;
}

/** A pause / resume / cancel / retime of one of the user's own schedules. */
export interface JarvisScheduleChangeCard {
  kind: "schedule_change";
  draft_id: string;
  revision: number;
  action: "pause" | "resume" | "cancel" | "retime";
  summary: string;
  destination: string;
  /** The schedule as the user reviewed it. */
  schedule: Schedule;
  after: { status: ScheduleStatus; schedule: ScheduleSpec; run_at: number; next_runs: number[] };
  dst_note: string | null;
  time_note?: string | null;
  expires_in: number;
}

export interface JarvisSchedulesCard {
  kind: "schedules";
  items: JarvisScheduleItem[];
  total: number;
  offset: number;
  has_more: boolean;
  /** More than the server scans exist; the oldest finished ones aren't counted. */
  truncated: boolean;
}

export type JarvisCard =
  | { kind: "digest"; items: JarvisDigestItem[] }
  | { kind: "messages"; title: string; messages: JarvisMessageHit[] }
  | {
      kind: "draft";
      draft_id: string;
      channel_id: string;
      channel_name: string;
      group_id: string;
      group_name: string;
      thread_id: number | null;
      thread_title?: string | null;
      destination: string;
      text: string;
      final_text: string;
      mentions: JarvisMention[];
      /** Seconds until the server forgets the draft. */
      expires_in: number;
      /** Bumped by every saved edit; a send quotes the revision it shows. */
      revision: number;
    }
  | JarvisScheduleDraftCard
  | JarvisScheduleChangeCard
  | JarvisSchedulesCard;

/** Cards a user confirms: they carry a server draft (id, revision, expiry). */
export type JarvisDraftLikeCard = Extract<JarvisCard, { draft_id: string }>;

export function isDraftLikeCard(card: JarvisCard): card is JarvisDraftLikeCard {
  return card.kind === "draft" || card.kind === "schedule_draft" || card.kind === "schedule_change";
}

export type JarvisEvent =
  | { type: "start"; conversation_id: string }
  | { type: "status"; phase: JarvisServerPhase; label: string }
  | { type: "tool"; name: string; summary: string }
  | { type: "delta"; text: string }
  | { type: "card"; card: JarvisCard }
  /** The user approved the offered draft in their own words; it was posted. */
  | { type: "draft_sent"; draft_id: string; message: Message; already_sent?: boolean }
  /** A schedule draft was confirmed (spoken yes): created, or changed by `action`. */
  | { type: "schedule_applied"; draft_id: string; action: "create" | "pause" | "resume" | "cancel" | "retime"; schedule: Schedule; already_applied?: boolean }
  /** Cancelled by a spoken "no", or replaced by a newer draft (`superseded_by`). */
  | { type: "draft_cancelled"; draft_id: string; superseded_by: string | null }
  /** Show this channel (and thread) in the app; checked against the caller server-side. */
  | { type: "navigate"; group_id: string; channel_id: string; thread_id: number | null; label: string }
  /** Hide the panel once the answer is spoken. Jarvis mode stays on. */
  | { type: "hide" }
  /** Start a new conversation once the answer is spoken (the panel's "New"). */
  | { type: "new_conversation" }
  | { type: "done"; conversation_id: string; text: string }
  | { type: "error"; message: string };

export interface JarvisTurnRequest {
  text: string;
  conversation_id?: string | null;
  context?: { channel_id?: string | null; thread_id?: number | null };
  /** Drafts whose card edit couldn't be saved: not approvable this turn. */
  unsaved_drafts?: string[];
  /** IANA timezone, carried by a reply-approved send like the card's Send. */
  timezone?: string;
  /** Minutes east of UTC right now: times the user says are read in it. */
  utc_offset_minutes?: number;
  /** The zone observes daylight saving (a UTC schedule will drift by an hour). */
  has_dst?: boolean;
  /** The zone's offset changes over the coming ~400 days, so a local time
      on a later date converts at the offset in force then. */
  tz_transitions?: TzTransition[];
}

/** From `at_utc` (unix seconds) on, the zone is `offset_minutes` east of UTC. */
export interface TzTransition {
  at_utc: number;
  offset_minutes: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Minutes east of UTC at `ms`; `|| 0` folds -0 into 0. */
function eastOffset(ms: number): number {
  return -new Date(ms).getTimezoneOffset() || 0;
}

/** The device clock for a turn: its UTC offset now, whether the zone shifts
    during the year (January and July offsets differ), and the offset changes
    it makes over the next `days` days (scanned a day at a time, then pinned
    to the minute). */
export function clientClock(
  now = new Date(),
  days = 400,
): { utc_offset_minutes: number; has_dst: boolean; tz_transitions: TzTransition[] } {
  const year = now.getFullYear();
  const jan = new Date(year, 0, 1).getTimezoneOffset();
  const jul = new Date(year, 6, 1).getTimezoneOffset();
  const start = now.getTime();
  const tz_transitions: TzTransition[] = [];
  let prevMs = start;
  let prev = eastOffset(start);
  for (let d = 1; d <= days; d++) {
    const ms = start + d * DAY_MS;
    const off = eastOffset(ms);
    if (off !== prev) {
      // The change is in (prevMs, ms]; offsets change on a whole minute,
      // so narrow it to the first minute on the new offset.
      let lo = Math.floor(prevMs / MINUTE_MS) * MINUTE_MS;
      let hi = Math.ceil(ms / MINUTE_MS) * MINUTE_MS;
      while (hi - lo > MINUTE_MS) {
        const mid = lo + Math.floor((hi - lo) / MINUTE_MS / 2) * MINUTE_MS;
        if (eastOffset(mid) === prev) lo = mid;
        else hi = mid;
      }
      tz_transitions.push({ at_utc: Math.floor(hi / 1000), offset_minutes: off });
      prev = off;
    }
    prevMs = ms;
  }
  return { utc_offset_minutes: eastOffset(start), has_dst: jan !== jul, tz_transitions };
}

/** Incremental SSE parser: feed arbitrary chunks, get whole events out.
    Handles CRLF, multi-line `data:`, comments, and chunk splits anywhere —
    including inside a multi-byte character (the decoder is streaming). */
export function createSseParser(onEvent: (event: JarvisEvent) => void) {
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const dispatch = () => {
    if (!data.length) return;
    const payload = data.join("\n");
    data = [];
    try {
      const parsed = JSON.parse(payload) as JarvisEvent;
      if (parsed && typeof parsed.type === "string") onEvent(parsed);
    } catch { /* ignore a malformed frame rather than kill the stream */ }
  };
  const line = (raw: string) => {
    const l = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (l === "") { dispatch(); return; }
    if (l.startsWith(":")) return;
    if (l.startsWith("data:")) data.push(l.slice(5).replace(/^ /, ""));
    // `event:` is redundant with the JSON `type`; ids/retry are unused.
  };
  return {
    push(chunk: Uint8Array | string) {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    },
    end() {
      buffer += decoder.decode();
      if (buffer) { line(buffer); buffer = ""; }
      dispatch();
    },
  };
}

/** Run one assistant turn, calling `onEvent` for each streamed event.
    Resolves when the stream ends; rejects on HTTP errors (e.g. ChatGPT not
    connected → 400 with a readable detail) or network failure. Abort via
    `signal` to stop listening (the server stops at its next step). */
export async function jarvisTurn(
  session: Session,
  request: JarvisTurnRequest,
  onEvent: (event: JarvisEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${session.baseUrl}/api/jarvis/turn`, {
    method: "POST",
    headers: { ...authHeaders(session), "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(request),
    signal,
  });
  if (!res.ok) throw await parseError(res);
  const parser = createSseParser(onEvent);
  if (!res.body) {
    parser.push(await res.text());
    parser.end();
    return;
  }
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) parser.push(value);
  }
  parser.end();
}

export interface JarvisTranscript {
  text: string;
  /** The recording held no speech (breath, rustle): keep listening. */
  noSpeech: boolean;
}

/** Transcribe one spoken turn for the assistant (nothing is posted). */
export async function jarvisTranscribe(session: Session, audio: Blob, signal?: AbortSignal): Promise<JarvisTranscript> {
  const type = (audio.type || "audio/webm").toLowerCase();
  // The transcription APIs infer the codec from the file extension.
  const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : "webm";
  const form = new FormData();
  form.append("file", audio, `jarvis-turn.${ext}`);
  const res = await fetch(`${session.baseUrl}/api/jarvis/transcribe`, {
    method: "POST", headers: authHeaders(session), body: form, signal,
  });
  if (!res.ok) throw await parseError(res);
  const body = (await res.json()) as { text?: string; no_speech?: boolean };
  const text = String(body.text || "").trim();
  return { text, noSpeech: body.no_speech === true || !text };
}

/** Synthesize one sentence of the assistant's answer with the instance's TTS. */
export async function jarvisSpeech(session: Session, text: string, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch(`${session.baseUrl}/api/jarvis/speech`, {
    method: "POST",
    headers: { ...authHeaders(session), "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!res.ok) throw await parseError(res);
  return res.blob();
}

/** What confirming a draft did. `refreshed`: a schedule changed after the
    user reviewed the change, so nothing was written; `events` carry the
    fresh card (and the old one's cancellation). */
export type JarvisConfirmResult =
  | { ok: true; kind?: "message"; message: Message; already_sent: boolean }
  | { ok: true; kind: "schedule"; action: "create" | "pause" | "resume" | "cancel" | "retime"; schedule: Schedule; already_sent: boolean }
  | { ok: false; kind: "refreshed"; draft_id: string; events: JarvisEvent[]; detail: string };

/** Confirm a draft at the revision the user sees: the server posts it (or
    creates / changes the schedule) as the signed-in user (409 if it was
    edited since; a repeat returns what was already done, with `already_sent`). */
export function sendJarvisDraft(api: ApiClient, draftId: string, revision: number) {
  return api.post<JarvisConfirmResult>(
    `/api/jarvis/drafts/${encodeURIComponent(draftId)}/send`,
    { revision, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  );
}

/** Save a card edit; returns the new revision (missing @mentions are re-added). */
export function updateJarvisDraft(api: ApiClient, draftId: string, text: string, revision: number) {
  return api.put<{ ok: true; draft_id: string; revision: number; text: string; final_text: string }>(
    `/api/jarvis/drafts/${encodeURIComponent(draftId)}`, { text, revision },
  );
}

export function cancelJarvisDraft(api: ApiClient, draftId: string) {
  return api.delete<{ ok: true; cancelled: boolean }>(`/api/jarvis/drafts/${encodeURIComponent(draftId)}`);
}

/** Forget a conversation; drafts it left pending are cancelled (their ids). */
export function resetJarvisConversation(api: ApiClient, conversationId: string) {
  return api.delete<{ ok: true; cancelled?: string[] }>(`/api/jarvis/conversations/${encodeURIComponent(conversationId)}`);
}
