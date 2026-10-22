/* The assistant's voice loop: hear a turn, run it, speak the answer while it
   streams, then keep listening for a follow-up.

     listen() ─ chime ─ "listening" ─ speech ─ "recording" ─ ~800 ms quiet
       ─ "transcribing" ─ /api/jarvis/transcribe ─ turn (thinking … ) ─
       answer streams; each finished sentence ─ /api/jarvis/speech ─ played
       in order ("speaking") ─ follow-up window (8 s "listening") ─ silence ─
       mic released, back to "armed" (the wake word takes over again)

   Talking over the answer (barge-in) stops the playback and starts a new
   capture. The mic is opened with echo cancellation so the assistant's own
   voice stays out; the wake detector stands down while this loop holds the
   mic (`micOwned`) and live voice, which owns the mic in a channel, always
   wins. Typed turns go through the same `runTurn`.

   Replies to a draft ("yes", "haan bhej do", "only if Priya agrees") are
   plain turns too: the server judges whether one approves the draft it just
   offered and posts it itself, streaming `draft_sent` / `draft_cancelled`
   and a short spoken acknowledgement. Nothing here guesses at intent.

   A module singleton (timers, recorder, audio), like live voice; the store
   (state/jarvis.ts) carries everything the panel renders. */

import {
  jarvisSpeech, jarvisTranscribe, jarvisTurn, resetJarvisConversation, type ApiClient,
} from "@agora/core";
import { sessionToken } from "../../lib/auth";
import { armChimeNow, playChime } from "../../lib/chime";
import { recMime, voiceSupported } from "../../lib/voice";
import { toast } from "../../lib/toast";
import { isLiveDraft, useJarvis } from "../../state/jarvis";
import { useLiveVoice } from "../../state/liveVoice";
import { useUiState } from "../../state/ui";
import { announceSent, saveDraftEdit, type JarvisDraftCard } from "../panel/JarvisCards";
import { jarvisLevel } from "../panel/level";
import { createEndpointer, frameRms } from "./endpointer";
import { createSentenceChunker, type Sentence } from "./sentences";

const TICK_MS = 50;
/** How long the loop waits for speech after opening, or after an answer. */
export const OPEN_WINDOW_MS = 10_000;
export const FOLLOW_UP_MS = 8_000;

const session = () => ({ baseUrl: "", token: sessionToken() });

/** What the panel knows: the API client and what the server can do. */
const caps = { api: null as ApiClient | null, stt: false, tts: false, open: false };

export function configureVoice(next: Partial<typeof caps>): void {
  Object.assign(caps, next);
}

/** Voice input is possible right now (not muted, configured, no live voice). */
export function canListen(): boolean {
  const st = useJarvis.getState();
  return caps.open && caps.stt && !st.micMuted && useLiveVoice.getState().scope === null && voiceSupported();
}

function canSpeak(): boolean {
  return caps.tts && !useJarvis.getState().speakerOff;
}

// ------------------------------------------------------------------ mic

type Capture = "off" | "waiting" | "recording" | "transcribing";

interface Mic {
  stream: MediaStream;
  ac: AudioContext;
  analyser: AnalyserNode;
  buf: Float32Array<ArrayBuffer>;
  timer: ReturnType<typeof setInterval>;
  recorder: MediaRecorder | null;
  chunks: Blob[];
  level: number;
}

let mic: Mic | null = null;
let micOpening: Promise<Mic | null> | null = null;
let wantMic = false;
let capture: Capture = "off";
/** performance.now() deadline for speech to start, or null to wait indefinitely. */
let listenUntil: number | null = null;
const endpointer = createEndpointer();

async function openMic(): Promise<Mic | null> {
  if (mic) return mic;
  if (micOpening) return micOpening;
  micOpening = (async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
      useJarvis.getState().failTurn(denied
        ? "Microphone access is off — allow it, or mute the mic and type instead."
        : `The microphone could not start: ${(e as Error).message}`);
      return null;
    }
    if (!wantMic) {
      stream.getTracks().forEach(t => t.stop());
      return null;
    }
    const ac = new AudioContext();
    if (ac.state === "suspended") void ac.resume().catch(() => {});
    const analyser = ac.createAnalyser();
    analyser.fftSize = 1024;
    ac.createMediaStreamSource(stream).connect(analyser);
    mic = {
      stream, ac, analyser, buf: new Float32Array(analyser.fftSize),
      timer: setInterval(tick, TICK_MS), recorder: null, chunks: [], level: 0,
    };
    useJarvis.getState().setMicOwned(true);
    return mic;
  })();
  try {
    return await micOpening;
  } finally {
    micOpening = null;
  }
}

function closeMic(): void {
  wantMic = false;
  capture = "off";
  listenUntil = null;
  endpointer.reset();
  const m = mic;
  if (!m) return;
  mic = null;
  clearInterval(m.timer);
  if (m.recorder) {
    m.recorder.ondataavailable = null;
    m.recorder.onstop = null;
    try { m.recorder.stop(); } catch { /* already stopped */ }
  }
  m.stream.getTracks().forEach(t => t.stop());
  void m.ac.close().catch(() => {});
  useJarvis.getState().setMicOwned(false);
}

/** Start (or restart) listening for a turn. `followUp` waits a shorter
    window and skips the chime: the conversation is already going. */
export async function listen(reason: "open" | "followUp" = "open"): Promise<void> {
  if (!canListen()) return;
  // Mid-turn (a wake or an unmute while it answers): no chime, since the
  // capture waits for the follow-up, but the mic still opens so talking
  // over the answer interrupts it.
  const busy = useJarvis.getState().busy;
  wantMic = true;
  if (reason === "open" && !busy) {
    armChimeNow();
    playChime(0.5);
  }
  const m = await openMic();
  if (!m || !wantMic || !canListen()) return;
  if (capture === "recording" || capture === "transcribing") return;
  if (useJarvis.getState().busy) return; // a turn started while the mic opened
  capture = "waiting";
  endpointer.reset();
  listenUntil = performance.now() + (reason === "followUp" ? FOLLOW_UP_MS : OPEN_WINDOW_MS);
  useJarvis.getState().setVoicePhase("listening");
}

/** Release the mic and go back to resting (the wake word re-arms). */
export function stopListening(): void {
  const capturing = capture !== "off";
  closeMic();
  if (capturing) useJarvis.getState().setVoicePhase(null);
}

function tick(): void {
  const m = mic;
  if (!m) return;
  m.analyser.getFloatTimeDomainData(m.buf);
  const rms = frameRms(m.buf);
  m.level = Math.min(1, rms * 14);
  const now = performance.now();
  const playing = speech.playing;
  if (!playing && capture !== "waiting" && capture !== "recording") return;
  const event = endpointer.step(rms, now, playing);
  if (event === "barge") {
    // Talking over the answer: drop it (speech and any text still
    // streaming) and hear the interruption.
    turnSilenced = true;
    stopSpeech();
    if (turnAbort) {
      turnAbort.abort();
      turnAbort = null;
      useJarvis.getState().endTurn();
    }
    beginRecording(m);
  } else if (event === "start" && capture === "waiting") {
    beginRecording(m);
  } else if ((event === "end" || event === "discard") && capture === "recording") {
    finishRecording(m, event === "end");
  } else if (capture === "waiting" && listenUntil != null && now > listenUntil && !playing) {
    stopListening();
  }
}

function beginRecording(m: Mic): void {
  if (m.recorder) return;
  const mime = recMime();
  let recorder: MediaRecorder;
  try {
    recorder = mime ? new MediaRecorder(m.stream, { mimeType: mime }) : new MediaRecorder(m.stream);
  } catch (e) {
    useJarvis.getState().failTurn("Recording failed: " + (e as Error).message);
    stopListening();
    return;
  }
  m.chunks = [];
  recorder.ondataavailable = e => { if (e.data?.size) m.chunks.push(e.data); };
  m.recorder = recorder;
  capture = "recording";
  listenUntil = null;
  recorder.start();
  useJarvis.getState().setVoicePhase("recording");
}

function finishRecording(m: Mic, keep: boolean): void {
  const recorder = m.recorder;
  if (!recorder) return;
  recorder.onstop = () => {
    const chunks = m.chunks;
    m.recorder = null;
    m.chunks = [];
    if (mic !== m) return;
    if (!keep || !chunks.length) {
      // A cough or a click: never send it, keep listening.
      capture = "waiting";
      listenUntil = performance.now() + FOLLOW_UP_MS;
      useJarvis.getState().setVoicePhase("listening");
      return;
    }
    void transcribe(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
  };
  capture = "transcribing";
  useJarvis.getState().setVoicePhase("transcribing");
  try { recorder.stop(); } catch { recorder.onstop?.(new Event("stop")); }
}

async function transcribe(blob: Blob): Promise<void> {
  let text = "";
  try {
    // Breath and rustle come back as `noSpeech` (empty text): routine
    // hands-free, so it just keeps listening without an error.
    const heard = await jarvisTranscribe(session(), blob);
    text = heard.noSpeech ? "" : heard.text;
  } catch (e) {
    useJarvis.setState({ error: (e as Error).message || "Transcription failed" });
  }
  if (!mic) return;
  if (!text) {
    capture = "waiting";
    listenUntil = performance.now() + FOLLOW_UP_MS;
    useJarvis.getState().setVoicePhase("listening");
    return;
  }
  capture = "off";
  await handleUtterance(text);
}

// ------------------------------------------------------------------ turns

let turnAbort: AbortController | null = null;
/** Barge-in silences the rest of the answer being spoken. */
let turnSilenced = false;

/** A spoken or typed turn. Everything goes to the server, replies to a
    draft included: it alone decides whether one approves the draft. */
export async function handleUtterance(text: string): Promise<void> {
  await runTurn(text);
}

/** The server posted a draft the user approved: the card's Undo toast —
    unless the card's Send got there first and already showed one. */
function onDraftSent(draftId: string, messageId: number, alreadySent: boolean): void {
  const entry = useJarvis.getState().cards.find(c => c.card.kind === "draft" && c.card.draft_id === draftId);
  if (entry && caps.api && !alreadySent) announceSent(caps.api, entry.id, entry.card as JarvisDraftCard, messageId);
}

/** Card edits still waiting for their debounce are saved before the turn,
    so a spoken yes is judged against the text the card shows. Resolves the
    drafts whose edit could not be saved: the server won't let this turn
    approve those, since its copy is not what the card shows. */
async function flushDraftEdits(): Promise<string[]> {
  const api = caps.api;
  if (!api) return [];
  const edited = useJarvis.getState().cards.filter(c => isLiveDraft(c) && c.text !== undefined);
  const saved = await Promise.all(edited.map(c => saveDraftEdit(api, c.id)));
  return edited.filter((_, i) => !saved[i]).map(c => (c.card as JarvisDraftCard).draft_id);
}

/** A dropped connection reads as a browser error ("Failed to fetch"); say it plainly, once. */
function turnFailure(e: unknown): string {
  if (e instanceof TypeError) return "Couldn't reach Agora — check the connection and try again.";
  return (e as Error).message || "The assistant is unavailable";
}

/** Run one assistant turn (typed or spoken), speaking the answer as it streams. */
export async function runTurn(raw: string): Promise<void> {
  const ask = raw.trim();
  if (!ask) return;
  turnAbort?.abort();
  stopSpeech();
  if (mic?.recorder) {
    mic.recorder.ondataavailable = null;
    mic.recorder.onstop = () => { if (mic) mic.recorder = null; };
    try { mic.recorder.stop(); } catch { mic.recorder = null; }
  }
  capture = "off";
  listenUntil = null;
  turnSilenced = false;
  const ctl = new AbortController();
  turnAbort = ctl;
  const store = useJarvis.getState();
  store.beginTurn(ask);
  const unsaved = await flushDraftEdits();
  if (ctl.signal.aborted) return;
  const answerId = useJarvis.getState().log.at(-1)?.id ?? "";
  const chunker = createSentenceChunker();
  let streamed = false;
  const ui = useUiState.getState();
  try {
    await jarvisTurn(
      session(),
      {
        text: ask,
        conversation_id: store.conversationId,
        context: ui.view.kind === "channel" && ui.sel.c ? { channel_id: ui.sel.c, thread_id: ui.threadRoot } : undefined,
        unsaved_drafts: unsaved.length ? unsaved : undefined,
      },
      event => {
        if (ctl.signal.aborted) return;
        if (event.type === "delta") jarvisLevel.bump();
        else if (event.type === "status" && event.phase !== "speaking") jarvisLevel.bump(0.12);
        useJarvis.getState().applyEvent(event);
        if (event.type === "draft_sent") onDraftSent(event.draft_id, event.message.id, event.already_sent === true);
        // The answer is still being spoken: no flash of "armed" in between.
        if (event.type === "done" && (speech.playing || speech.queue.length)) useJarvis.getState().setVoicePhase("speaking");
        if (event.type === "delta") {
          streamed = true;
          chunker.push(event.text).forEach(s => enqueueSpeech(answerId, s));
        } else if (event.type === "done" && !streamed && event.text) {
          chunker.push(event.text).forEach(s => enqueueSpeech(answerId, s));
        }
      },
      ctl.signal,
    );
    if (ctl.signal.aborted) return;
    chunker.flush().forEach(s => enqueueSpeech(answerId, s));
    useJarvis.getState().endTurn();
  } catch (e) {
    if (ctl.signal.aborted) return;
    useJarvis.getState().failTurn(turnFailure(e));
  } finally {
    if (turnAbort === ctl) turnAbort = null;
  }
  afterTurn();
}

/** Once the answer has been spoken, listen for a follow-up (or rest). */
function afterTurn(): void {
  whenSpeechDrained(() => {
    if (useJarvis.getState().busy) return;
    if (canListen() && caps.open) {
      if (useJarvis.getState().phase === "speaking") useJarvis.getState().setVoicePhase(null);
      void listen("followUp");
    } else {
      stopListening();
      if (useJarvis.getState().phase === "speaking") useJarvis.getState().setVoicePhase(null);
    }
  });
}

/** Stop everything: the panel closed. */
export function closeVoice(): void {
  turnAbort?.abort();
  turnAbort = null;
  stopSpeech();
  stopListening();
  useJarvis.getState().endTurn();
  useJarvis.getState().setVoicePhase(null);
}

/** Abort the running turn without closing (the panel's "New"). */
export function abortTurn(): void {
  turnAbort?.abort();
  turnAbort = null;
  stopSpeech();
  useJarvis.getState().endTurn();
}

/** The panel's "New": abort the turn, tell the server to forget the
    conversation (it would otherwise keep the transcript for its idle TTL),
    and reset the session. Fire-and-forget: a failed delete just expires. */
export function newConversation(api: ApiClient): void {
  abortTurn();
  const id = useJarvis.getState().conversationId;
  if (id) void resetJarvisConversation(api, id).catch(() => {});
  useJarvis.getState().reset();
}

// ------------------------------------------------------------------ speech

interface Clip {
  entryId: string;
  sentence: Sentence;
  audio: Promise<Blob | null>;
}

const speech = {
  queue: [] as Clip[],
  playing: false,
  el: null as HTMLAudioElement | null,
  source: null as MediaElementAudioSourceNode | null,
  url: "",
  gen: 0,
  abort: null as AbortController | null,
  drained: null as null | (() => void),
  warned: false,
};

let playback: { ac: AudioContext; analyser: AnalyserNode; buf: Float32Array<ArrayBuffer> } | null = null;
let playbackRouted = false;

function enqueueSpeech(entryId: string, sentence: Sentence): void {
  if (!canSpeak() || turnSilenced) return;
  speech.abort ??= new AbortController();
  const signal = speech.abort.signal;
  const audio = jarvisSpeech(session(), sentence.text, signal).catch((e: Error) => {
    if (!signal.aborted && !speech.warned) {
      speech.warned = true;
      toast("Couldn't speak the reply: " + (e.message || "speech failed"), { variant: "warn" });
    }
    return null;
  });
  speech.queue.push({ entryId, sentence, audio });
  if (!speech.playing) void playNext(speech.gen);
}

function speakText(entryId: string, text: string): void {
  const chunker = createSentenceChunker();
  [...chunker.push(text), ...chunker.flush()].forEach(s => enqueueSpeech(entryId, s));
}

function routeThroughAnalyser(el: HTMLAudioElement): void {
  playbackRouted = false;
  try {
    if (!playback) {
      const ac = new AudioContext();
      const analyser = ac.createAnalyser();
      analyser.fftSize = 1024;
      analyser.connect(ac.destination);
      playback = { ac, analyser, buf: new Float32Array(analyser.fftSize) };
    }
    if (playback.ac.state === "suspended") void playback.ac.resume().catch(() => {});
    // A suspended context would swallow the audio: only route when running.
    if (playback.ac.state !== "running") return;
    speech.source = playback.ac.createMediaElementSource(el);
    speech.source.connect(playback.analyser);
    playbackRouted = true;
  } catch { /* plain element playback; the beam falls back to a simulated level */ }
}

async function playNext(gen: number): Promise<void> {
  if (gen !== speech.gen || speech.playing) return;
  const clip = speech.queue.shift();
  if (!clip) {
    useJarvis.getState().setSpoken(null);
    const done = speech.drained;
    speech.drained = null;
    done?.();
    return;
  }
  speech.playing = true;
  const blob = await clip.audio;
  if (gen !== speech.gen) return;
  if (!blob) {
    speech.playing = false;
    void playNext(gen);
    return;
  }
  const url = URL.createObjectURL(blob);
  const el = new Audio();
  el.setAttribute("playsinline", "");
  el.src = url;
  routeThroughAnalyser(el);
  speech.el = el;
  speech.url = url;
  endpointer.reset();
  const st = useJarvis.getState();
  st.setSpoken({ id: clip.entryId, start: clip.sentence.start, end: clip.sentence.end });
  st.setVoicePhase("speaking");
  const finished = () => {
    if (speech.el !== el) return;
    releaseClip();
    speech.playing = false;
    void playNext(gen);
  };
  el.onended = finished;
  el.onerror = finished;
  el.ontimeupdate = () => { if (!playbackRouted) jarvisLevel.bump(0.5); };
  try {
    await el.play();
  } catch {
    if (!speech.warned) {
      speech.warned = true;
      toast("Couldn't play the reply — click anywhere in Agora to allow sound", { variant: "warn" });
    }
    finished();
  }
}

function releaseClip(): void {
  const el = speech.el;
  if (el) {
    el.onended = null;
    el.onerror = null;
    el.ontimeupdate = null;
    try { el.pause(); } catch { /* already stopped */ }
  }
  speech.source?.disconnect();
  speech.source = null;
  if (speech.url) URL.revokeObjectURL(speech.url);
  speech.el = null;
  speech.url = "";
}

/** Stop speaking now and drop what is queued (barge-in, mute, close). */
export function stopSpeech(): void {
  speech.gen++;
  speech.abort?.abort();
  speech.abort = null;
  speech.queue = [];
  releaseClip();
  speech.playing = false;
  speech.drained = null;
  speech.warned = false;
  useJarvis.getState().setSpoken(null);
}

function whenSpeechDrained(then: () => void): void {
  if (!speech.playing && !speech.queue.length) {
    then();
    return;
  }
  speech.drained = then;
}

/** The speaker toggle went off mid-answer: finish silently, then follow up. */
export function silenceSpeech(): void {
  const then = speech.drained;
  stopSpeech();
  then?.();
}

// ------------------------------------------------------------------ level

/** Beam level: playback while speaking, the mic while listening. */
function liveLevel(): number | null {
  if (speech.playing && playbackRouted && playback) {
    playback.analyser.getFloatTimeDomainData(playback.buf);
    return Math.min(1, frameRms(playback.buf) * 5);
  }
  if (speech.playing) return null; // simulated by ontimeupdate bumps
  if (mic && (capture === "waiting" || capture === "recording")) return mic.level;
  return null;
}
jarvisLevel.source = liveLevel;

// Live voice owns the mic in a channel: stand down when it starts.
useLiveVoice.subscribe((s, prev) => {
  if (s.scope && !prev.scope) {
    stopSpeech();
    stopListening();
  }
});

/** For tests and stories: what the loop is doing. */
export function voiceDebugState() {
  return { capture, micOpen: mic !== null, speaking: speech.playing, queued: speech.queue.length };
}
