/* Jarvis mode client: the Agora assistant's streaming turn endpoint
   (POST /api/jarvis/turn, Server-Sent Events) and the draft confirm/cancel
   calls. Shapes mirror crates/agora-core/src/jarvis.rs. */

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
    };

export type JarvisEvent =
  | { type: "start"; conversation_id: string }
  | { type: "status"; phase: JarvisServerPhase; label: string }
  | { type: "tool"; name: string; summary: string }
  | { type: "delta"; text: string }
  | { type: "card"; card: JarvisCard }
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

/** Transcribe one spoken turn for the assistant (nothing is posted). */
export async function jarvisTranscribe(session: Session, audio: Blob, signal?: AbortSignal): Promise<string> {
  const type = (audio.type || "audio/webm").toLowerCase();
  // The transcription APIs infer the codec from the file extension.
  const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : "webm";
  const form = new FormData();
  form.append("file", audio, `jarvis-turn.${ext}`);
  const res = await fetch(`${session.baseUrl}/api/jarvis/transcribe`, {
    method: "POST", headers: authHeaders(session), body: form, signal,
  });
  if (!res.ok) throw await parseError(res);
  return String(((await res.json()) as { text?: string }).text || "").trim();
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

/** Confirm a draft: the server posts it as the signed-in user. `text`
    replaces the drafted body (missing @mentions are re-added). */
export function sendJarvisDraft(api: ApiClient, draftId: string, text?: string) {
  return api.post<{ ok: true; message: Message }>(
    `/api/jarvis/drafts/${encodeURIComponent(draftId)}/send`,
    { ...(text === undefined ? {} : { text }), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  );
}

export function cancelJarvisDraft(api: ApiClient, draftId: string) {
  return api.delete<{ ok: true; cancelled: boolean }>(`/api/jarvis/drafts/${encodeURIComponent(draftId)}`);
}

export function resetJarvisConversation(api: ApiClient, conversationId: string) {
  return api.delete<{ ok: true }>(`/api/jarvis/conversations/${encodeURIComponent(conversationId)}`);
}
