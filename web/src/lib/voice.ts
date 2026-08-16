/* Shared audio plumbing for the voice features: recorder mime picking, the
   reusable TTS player with its autoplay unlock, and the /voice upload.
   Server side: POST /api/channels/{id}/voice (STT) and
   GET /api/messages/{id}/speech (TTS); both need OPENAI_API_KEY there. */

import { sessionToken } from "./auth";
import { toast } from "./toast";

export function recMime(): string {
  // Chrome/Firefox record webm/opus; Safari records mp4 (AAC). Both are
  // accepted by the transcription API.
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

export function voiceSupported(): boolean {
  return !!navigator.mediaDevices && typeof MediaRecorder !== "undefined";
}

/* One reused element for TTS — iOS needs playsInline and a gesture unlock. */
let _player: HTMLAudioElement | null = null;
let _playWarned = false;

export function player(): HTMLAudioElement {
  if (!_player) {
    _player = new Audio();
    _player.setAttribute("playsinline", "");
    (_player as HTMLAudioElement & { playsInline: boolean }).playsInline = true;
  }
  return _player;
}

/* Mobile browsers (especially iOS Safari) block audio.play() unless the page
   has been "unlocked" by a recent user gesture — call from 🔊 / 🎧 taps. */
export async function unlockPlayback(): Promise<void> {
  const p = player();
  // Tiny silent WAV — just enough to satisfy the autoplay gate.
  p.src = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
  try {
    await p.play();
    p.pause();
    p.currentTime = 0;
    p.removeAttribute("src");
    p.load();
  } catch { /* still try playback later */ }
}

export async function playSpeech(url: string, onDone: () => void): Promise<HTMLAudioElement | null> {
  const audio = player();
  audio.onended = null;
  audio.onerror = null;
  audio.src = url;
  const done = () => { audio.onended = null; audio.onerror = null; onDone(); };
  audio.onended = done;
  audio.onerror = done;
  try {
    await audio.play();
    return audio;
  } catch {
    if (!_playWarned) {
      _playWarned = true;
      toast("Couldn't play the reply — tap the speaker or Live button again to allow sound on this device",
        { variant: "warn" });
    }
    done();
    return null;
  }
}

export function stopAudio(audio: HTMLAudioElement | null): void {
  const a = audio || (_player && !_player.paused ? _player : null);
  if (!a) return;
  a.onended = null;
  a.onerror = null;
  try { a.pause(); } catch { /* already stopped */ }
  if (a.src && a.src.startsWith("blob:")) URL.revokeObjectURL(a.src);
}

function timezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; }
}

/** Upload a recording to /voice; the server transcribes and posts the
    message (the WS echo delivers it to every client, including us). */
export async function uploadVoice(v: {
  channelId: string;
  threadId: number | null;
  blob: Blob;
  live?: boolean;
  /** Thread sticky: close the agent floor unless someone is @mentioned.
      Ignored for live turns (hub drops require_agent when voice=true). */
  requireAgent?: boolean;
}): Promise<void> {
  const type = (v.blob.type || "audio/webm").toLowerCase();
  // The transcription API infers the codec from the file extension.
  const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
  const fd = new FormData();
  fd.append("file", v.blob, (v.live ? "utterance." : "voice-note.") + ext);
  if (v.live) fd.append("live", "true");
  if (v.threadId != null) fd.append("thread_id", String(v.threadId));
  const tz = timezone();
  if (tz) fd.append("timezone", tz);
  if (v.requireAgent && v.threadId != null && !v.live) fd.append("require_agent", "true");
  const res = await fetch(`/api/channels/${encodeURIComponent(v.channelId)}/voice`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sessionToken()}` },
    body: fd,
  });
  if (!res.ok) {
    let detail = await res.text();
    try { detail = JSON.parse(detail).detail || detail; } catch { /* plain text */ }
    throw new Error(detail);
  }
}

export async function fetchSpeechUrl(messageId: number): Promise<string> {
  const res = await fetch(`/api/messages/${messageId}/speech`, {
    headers: { Authorization: `Bearer ${sessionToken()}` },
  });
  if (!res.ok) {
    let detail = await res.text();
    try { detail = JSON.parse(detail).detail || detail; } catch { /* plain text */ }
    const err = new Error(detail) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return URL.createObjectURL(await res.blob());
}
