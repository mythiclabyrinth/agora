/* Jarvis mode client: the Agora assistant's streaming turn endpoint
   (POST /api/jarvis/turn, Server-Sent Events) and the draft edit/confirm/
   cancel calls. Shapes mirror crates/agora-core/src/jarvis.rs. */

import { ApiClient, authHeaders, parseError, type Session } from "../api/client";
import type { Message } from "../api/types";

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
    };

export type JarvisEvent =
  | { type: "start"; conversation_id: string }
  | { type: "status"; phase: JarvisServerPhase; label: string }
  | { type: "tool"; name: string; summary: string }
  | { type: "delta"; text: string }
  | { type: "card"; card: JarvisCard }
  /** The user approved the offered draft in their own words; it was posted. */
  | { type: "draft_sent"; draft_id: string; message: Message }
  /** Cancelled by a spoken "no", or replaced by a newer draft (`superseded_by`). */
  | { type: "draft_cancelled"; draft_id: string; superseded_by: string | null }
  | { type: "done"; conversation_id: string; text: string }
  | { type: "error"; message: string };

export interface JarvisTurnRequest {
  text: string;
  conversation_id?: string | null;
  context?: { channel_id?: string | null; thread_id?: number | null };
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

/** Confirm a draft at the revision the user sees: the server posts it as
    the signed-in user (409 if it was edited since; a repeat returns the
    message already posted, with `already_sent`). */
export function sendJarvisDraft(api: ApiClient, draftId: string, revision: number) {
  return api.post<{ ok: true; message: Message; already_sent: boolean }>(
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
