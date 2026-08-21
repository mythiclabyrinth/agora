/* Live voice mode (hands-free two-way conversation). A browser-side
   cascade: WebAudio VAD endpoints each utterance
   (speech starts above an RMS threshold, ends after a silence gap), the
   clip goes to /voice?live=true, and agent replies come back as normal
   messages that get auto-spoken via /speech. Sustained speech during
   playback interrupts it (barge-in); the browser's echo cancellation keeps
   the agent's own voice out of the mic.

   The session itself is a module singleton (timers, recorder, audio); a
   small zustand store mirrors the UI-visible bits (scope + state) so React
   re-renders the strip and buttons. */

import { create } from "zustand";
import type { Message } from "@agora/core";
import {
  fetchSpeechUrl, playSpeech, recMime, stopAudio, unlockPlayback, voiceSupported,
} from "../lib/voice";
import { uploadVoice } from "../lib/voice";
import { toast } from "../lib/toast";
import { speakStop, useSpeak } from "./speak";

const TICK_MS = 50;            // VAD poll interval
const SILENCE_MS = 800;        // utterance ends after this much quiet
const MIN_UTTER_MS = 300;      // shorter blips are coughs/key clicks — dropped
const BARGE_MS = 150;          // sustained speech during playback interrupts it
const THRESHOLD = 0.015;       // RMS speech threshold on the mic signal
const TURN_TIMEOUT_MS = 60000; // stop waiting for an agent reply after this long

export type LiveUiState = "listening" | "recording" | "thinking" | "speaking";

const LABELS: Record<LiveUiState, string> = {
  listening: "Listening — just talk",
  recording: "Recording…",
  thinking: "Thinking…",
  speaking: "Speaking — talk to interrupt",
};

export function liveLabel(state: LiveUiState, speakOn: boolean, muted = false): string {
  // The Mute control already shows muted-ness; the label only changes when
  // muted alters what talking does (idle), not mid thinking/speaking.
  if (muted && state === "listening") {
    return speakOn ? "Muted — tap Unmute to talk" : "Muted — replies appear in chat";
  }
  // With 🔊 off the session still listens and posts turns, but replies stay
  // text-only — say so instead of implying audio is coming.
  if (state === "listening" && !speakOn) {
    return "Listening — replies appear in chat (speaker off)";
  }
  return LABELS[state] || state;
}

interface LiveSession {
  channelId: string;
  threadId: number | null;
  stream: MediaStream;
  ac: AudioContext;
  analyser: AnalyserNode;
  buf: Float32Array<ArrayBuffer>;
  timer: ReturnType<typeof setInterval> | null;
  recorder: MediaRecorder | null;
  chunks: Blob[];
  utterStart: number;
  lastVoice: number;
  voicedMs: number;             // consecutive voiced ms during playback
  turnBusy: boolean;
  turnTimer: ReturnType<typeof setTimeout> | null;
  queue: Blob[];
  playQueue: number[];
  audio: HTMLAudioElement | null;
  muted: boolean;
}

let session: LiveSession | null = null;

interface LiveVoiceState {
  /** Scope of the running session, null when off. */
  scope: { channelId: string; threadId: number | null } | null;
  state: LiveUiState;
  muted: boolean;
}

export const useLiveVoice = create<LiveVoiceState>(() => ({
  scope: null,
  state: "listening",
  muted: false,
}));

export function liveScopeActive(channelId: string | undefined, threadId: number | null): boolean {
  const s = useLiveVoice.getState().scope;
  return !!s && s.channelId === channelId && s.threadId === (threadId ?? null);
}

// Turning 🔊 off mid-sentence also mutes a live session's playback;
// wired here to avoid a circular import.
useSpeak.subscribe((s, prev) => {
  if (prev.on && !s.on) stopPlayback();
});

function setState(live: LiveSession, state: LiveUiState): void {
  if (session !== live) return;
  if (useLiveVoice.getState().state !== state) useLiveVoice.setState({ state });
}

function rms(live: LiveSession): number {
  live.analyser.getFloatTimeDomainData(live.buf);
  let sum = 0;
  for (let i = 0; i < live.buf.length; i++) sum += live.buf[i] * live.buf[i];
  return Math.sqrt(sum / live.buf.length);
}

function tick(): void {
  const live = session;
  if (!live) return;
  if (live.muted) {
    if (!live.audio && !live.recorder) {
      setState(live, live.turnBusy ? "thinking" : "listening");
    }
    return;
  }
  const now = Date.now();
  const voiced = rms(live) >= THRESHOLD;

  // Barge-in: sustained speech while agent audio plays cancels the playback
  // queue and starts capturing the interruption as a fresh utterance.
  if (live.audio) {
    live.voicedMs = voiced ? live.voicedMs + TICK_MS : 0;
    if (live.voicedMs >= BARGE_MS) {
      live.voicedMs = 0;
      stopPlayback(live);
      beginUtterance(live, now);
      return;
    }
    setState(live, "speaking");
    return;
  }

  if (!live.recorder) {
    if (voiced) beginUtterance(live, now);
    else setState(live, live.turnBusy ? "thinking" : "listening");
    return;
  }
  if (voiced) live.lastVoice = now;
  if (now - live.lastVoice >= SILENCE_MS) endUtterance(live);
  else setState(live, "recording");
}

function beginUtterance(live: LiveSession, now: number): void {
  if (live.recorder) return;
  const mime = recMime();
  let recorder: MediaRecorder;
  try {
    recorder = mime
      ? new MediaRecorder(live.stream, { mimeType: mime })
      : new MediaRecorder(live.stream);
  } catch (e) {
    toast("Live voice recording failed: " + (e as Error).message, { variant: "warn" });
    liveStop();
    return;
  }
  live.chunks = [];
  recorder.ondataavailable = e => { if (e.data && e.data.size) live.chunks.push(e.data); };
  recorder.onstop = () => {
    const ms = live.lastVoice - live.utterStart;
    const chunks = live.chunks;
    live.recorder = null;
    live.chunks = [];
    if (session !== live) return;                       // session ended while recording
    if (ms < MIN_UTTER_MS || !chunks.length) return;    // noise blip
    live.queue.push(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
    void pump(live);
  };
  live.recorder = recorder;
  live.utterStart = now;
  live.lastVoice = now;
  recorder.start();
  setState(live, "recording");
}

function endUtterance(live: LiveSession): void {
  const rec = live.recorder;
  if (!rec) return;
  try { rec.stop(); } catch { live.recorder = null; }
}

/* One turn in flight at a time: utterances spoken while the agent is
   thinking queue up and post sequentially. */
async function pump(live: LiveSession): Promise<void> {
  if (session !== live || live.turnBusy || !live.queue.length) return;
  live.turnBusy = true;
  setState(live, "thinking");
  if (live.turnTimer) clearTimeout(live.turnTimer);
  // Safety valve: a channel with no live agents (or a dropped reply) must
  // not wedge the session in "thinking" forever.
  live.turnTimer = setTimeout(() => {
    live.turnBusy = false;
    void pump(live);
  }, TURN_TIMEOUT_MS);
  const blob = live.queue.shift()!;
  try {
    await uploadVoice({ channelId: live.channelId, threadId: live.threadId, blob, live: true });
  } catch (e) {
    // Inaudible clips (breath, rustle) are routine in a hands-free loop —
    // resume listening quietly instead of toasting an error.
    if (!/couldn't hear/i.test((e as Error).message || "")) {
      toast("Voice turn failed: " + (e as Error).message, { variant: "warn" });
    }
    if (live.turnTimer) clearTimeout(live.turnTimer);
    live.turnBusy = false;
    void pump(live);
  }
}

/* An agent reply landed in the live scope: close the pending turn and speak
   it — unless 🔊 is off, in which case it stays text-only. Wire from the
   socket's onAgentMessage. */
export function liveOnAgentMessage(m: Message): void {
  const live = session;
  if (!live || m.channel_id !== live.channelId) return;
  // Channel sessions take top-level replies, thread sessions their thread's.
  if ((m.thread_id != null ? m.thread_id : null) !== live.threadId) return;
  if (live.turnTimer) clearTimeout(live.turnTimer);
  live.turnBusy = false;
  if (useSpeak.getState().on) {
    live.playQueue.push(m.id);
    if (!live.audio) void playNext(live);
  } else {
    setState(live, "listening");
  }
  void pump(live);
}

async function playNext(live: LiveSession): Promise<void> {
  if (session !== live) return;
  const id = live.playQueue.shift();
  if (id == null) {
    live.audio = null;
    setState(live, live.turnBusy ? "thinking" : "listening");
    return;
  }
  let url: string;
  try {
    url = await fetchSpeechUrl(id);
  } catch (e) {
    const msg = (e as Error).message || "Speech synthesis failed";
    toast("Couldn't speak the reply: " + msg, { variant: "warn" });
    void playNext(live); // unspeakable message — keep the queue moving
    return;
  }
  if (session !== live) { URL.revokeObjectURL(url); return; }
  live.voicedMs = 0;
  setState(live, "speaking");
  const done = () => {
    URL.revokeObjectURL(url);
    if (live.audio) { live.audio = null; void playNext(live); }
  };
  live.audio = await playSpeech(url, done);
  if (!live.audio) done();
}

export function stopPlayback(live?: LiveSession | null): void {
  const l = live ?? session;
  if (!l) return;
  l.playQueue = [];
  const audio = l.audio;
  l.audio = null;
  stopAudio(audio);
}

/** Mute keeps the live session and reply playback alive. When the user mutes
    while speaking, treat it as an explicit end-of-turn so background noise
    cannot hold the VAD open and delay the agent response. */
export function liveMuteToggle(): void {
  const live = session;
  if (!live) return;
  live.muted = !live.muted;
  if (live.muted) {
    if (live.recorder) endUtterance(live);
    live.stream.getAudioTracks().forEach(track => { track.enabled = false; });
  } else {
    live.voicedMs = 0;
    live.stream.getAudioTracks().forEach(track => { track.enabled = true; });
  }
  useLiveVoice.setState({ muted: live.muted });
}

export function liveStop(): void {
  const live = session;
  if (!live) return;
  session = null;
  if (live.timer) clearInterval(live.timer);
  if (live.turnTimer) clearTimeout(live.turnTimer);
  const rec = live.recorder;
  if (rec) {
    rec.ondataavailable = null;
    rec.onstop = null;
    try { rec.stop(); } catch { /* already stopped */ }
  }
  stopPlayback(live);
  live.stream.getTracks().forEach(t => t.stop());
  try { void live.ac.close(); } catch { /* already closed */ }
  useLiveVoice.setState({ scope: null, state: "listening", muted: false });
}

export async function liveToggle(channelId: string, threadId: number | null): Promise<void> {
  threadId = threadId ?? null;
  if (session) {
    const same = liveScopeActive(channelId, threadId);
    liveStop();
    if (same) return; // same button: plain stop. Other scope: restart there.
  }
  if (!voiceSupported()) {
    toast("Live voice isn't supported in this browser", { variant: "warn" });
    return;
  }
  speakStop(); // don't fight the speak-aloud queue for the player
  let stream: MediaStream;
  try {
    // Echo cancellation is load-bearing: without it the agent's own playback
    // re-triggers the endpointer and the session talks to itself.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch {
    toast("Microphone blocked — allow mic access for live voice", { variant: "warn" });
    return;
  }
  const ac = new AudioContext();
  const analyser = ac.createAnalyser();
  analyser.fftSize = 1024;
  ac.createMediaStreamSource(stream).connect(analyser);
  session = {
    channelId, threadId, stream, ac, analyser,
    buf: new Float32Array(analyser.fftSize),
    timer: null,
    recorder: null, chunks: [], utterStart: 0, lastVoice: 0,
    voicedMs: 0,
    turnBusy: false, turnTimer: null, queue: [],
    playQueue: [], audio: null, muted: false,
  };
  session.timer = setInterval(tick, TICK_MS);
  useLiveVoice.setState({ scope: { channelId, threadId }, state: "listening", muted: false });
  // Playback unlock + AudioContext resume, deliberately not awaited: the
  // unlock clip's play() promise can stay pending forever in some webviews,
  // and the strip must render immediately.
  void unlockPlayback().then(() => {
    if (session && session.ac.state === "suspended") void session.ac.resume();
  });
}
