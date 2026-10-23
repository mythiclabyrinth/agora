/* The assistant's voice loop: hear a turn, run it, speak the answer while it
   streams, then keep listening for a follow-up.

     listen() ─ chime ─ "listening" ─ speech ─ "recording" ─ ~1.4 s quiet
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

   Recording starts when listening does (not when speech is first heard),
   so the first word isn't clipped; a window with no speech is dropped.

   The answer outlives the panel: closing it stops listening (and drops any
   recording), but the reply keeps streaming and speaking, so it can be
   heard while reading the thread it pointed at. "Stop speaking" silences
   the rest of an answer while its text and cards keep coming. Settings and
   teardown that must hold while the panel is closed live in
   JarvisVoiceHost, which is always mounted.

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
import { jumpTo } from "../navigate";
import { jarvisLevel } from "../panel/level";
import { createEndpointer, frameRms } from "./endpointer";
import { createSentenceChunker, type Sentence } from "./sentences";

const TICK_MS = 50;
/** How long the loop waits for speech after opening, or after an answer. */
export const OPEN_WINDOW_MS = 10_000;
export const FOLLOW_UP_MS = 8_000;

const session = () => ({ baseUrl: "", token: sessionToken() });

/** What the panel knows: the API client and what the server can do. */
const caps = { api: null as ApiClient | null, stt: false, tts: false, open: false, rate: 1 };

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

/** While waiting for speech the recording restarts this often, so a clip
    carries at most this much silence before the words (Whisper invents
    text on long silence). */
const MAX_LEAD_MS = 3_000;

interface Mic {
  stream: MediaStream;
  recorderStarted: number;
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
/** Bumped whenever capture is torn down: a transcription that finishes
    after that (the panel closed, or reopened since) is dropped. */
let captureGen = 0;
/** Quiet this long ends an utterance: a natural pause mid-request isn't
    the end of it (0.8 s split requests in two). */
export const END_OF_SPEECH_MS = 1400;
const endpointer = createEndpointer({ silenceMs: END_OF_SPEECH_MS });

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
      timer: setInterval(tick, TICK_MS), recorder: null, chunks: [], level: 0, recorderStarted: 0,
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
  captureGen++;
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
  // Mid-answer (a wake, an unmute, or reopening while it still talks): no
  // chime and no capture, which follows once the answer is spoken, but the
  // mic still opens so talking over the answer interrupts it.
  const answering = () => useJarvis.getState().busy || speech.playing || speech.queue.length > 0;
  wantMic = true;
  if (reason === "open" && !answering()) {
    armChimeNow();
    playChime(0.5);
  }
  const m = await openMic();
  if (!m || !wantMic || !canListen()) return;
  if (capture === "recording" || capture === "transcribing") return;
  if (answering()) return; // a turn started (or is still speaking) while the mic opened
  capture = "waiting";
  endpointer.reset();
  listenUntil = performance.now() + (reason === "followUp" ? FOLLOW_UP_MS : OPEN_WINDOW_MS);
  if (startRecorder(m)) useJarvis.getState().setVoicePhase("listening");
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
    beginRecording(m); // already recording since listening began: marks it
  } else if ((event === "end" || event === "discard") && capture === "recording") {
    finishRecording(m, event === "end");
  } else if (capture === "waiting" && listenUntil != null && now > listenUntil && !playing) {
    stopListening();
  } else if (capture === "waiting" && m.recorder && !endpointer.speaking && now - m.recorderStarted > MAX_LEAD_MS) {
    restartRecorder(m);
  }
}

/** Start the recorder (no-op if running). False when it can't start. */
function startRecorder(m: Mic): boolean {
  if (m.recorder) return true;
  const mime = recMime();
  let recorder: MediaRecorder;
  try {
    recorder = mime ? new MediaRecorder(m.stream, { mimeType: mime }) : new MediaRecorder(m.stream);
  } catch (e) {
    useJarvis.getState().failTurn("Recording failed: " + (e as Error).message);
    stopListening();
    return false;
  }
  m.chunks = [];
  recorder.ondataavailable = e => { if (e.data?.size) m.chunks.push(e.data); };
  m.recorder = recorder;
  m.recorderStarted = performance.now();
  recorder.start();
  return true;
}

/** Drop what the recorder holds and start again (still waiting for speech). */
function restartRecorder(m: Mic): void {
  if (m.recorder) {
    m.recorder.ondataavailable = null;
    m.recorder.onstop = null;
    try { m.recorder.stop(); } catch { /* already stopped */ }
    m.recorder = null;
  }
  m.chunks = [];
  startRecorder(m);
}

/** Drop what the recorder holds while still waiting for speech (New):
    nothing from before belongs in the next request. */
function discardWaitingAudio(): void {
  if (mic?.recorder && capture === "waiting") restartRecorder(mic);
}

/** Talking over the answer: record the interruption now. */
function beginRecording(m: Mic): void {
  if (!startRecorder(m)) return;
  capture = "recording";
  listenUntil = null;
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
      // A cough or a click: never send it, keep listening (and recording).
      capture = "waiting";
      listenUntil = performance.now() + FOLLOW_UP_MS;
      if (startRecorder(m)) useJarvis.getState().setVoicePhase("listening");
      return;
    }
    void transcribe(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }), captureGen);
  };
  capture = "transcribing";
  useJarvis.getState().setVoicePhase("transcribing");
  try { recorder.stop(); } catch { recorder.onstop?.(new Event("stop")); }
}

async function transcribe(blob: Blob, gen: number): Promise<void> {
  let text = "";
  try {
    // Breath and rustle come back as `noSpeech` (empty text): routine
    // hands-free, so it just keeps listening without an error.
    const heard = await jarvisTranscribe(session(), blob);
    text = heard.noSpeech ? "" : heard.text;
  } catch (e) {
    if (gen === captureGen) useJarvis.setState({ error: (e as Error).message || "Transcription failed" });
  }
  // Capture was torn down meanwhile (panel closed, or reopened since): a
  // late result must not start a turn nobody asked for.
  if (!mic || gen !== captureGen) return;
  if (!text) {
    capture = "waiting";
    listenUntil = performance.now() + FOLLOW_UP_MS;
    if (startRecorder(mic)) useJarvis.getState().setVoicePhase("listening");
    return;
  }
  capture = "off";
  await handleUtterance(text);
}

// ------------------------------------------------------------------ turns

let turnAbort: AbortController | null = null;
/** Barge-in silences the rest of the answer being spoken. */
let turnSilenced = false;
/** "Stop speaking": silent for the rest of this turn, and no follow-up capture. */
let turnQuiet = false;

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
  captureGen++; // a transcription still in flight must not take over this turn
  turnSilenced = false;
  turnQuiet = false;
  useJarvis.setState({ speechStopped: false });
  const ctl = new AbortController();
  turnAbort = ctl;
  const store = useJarvis.getState();
  store.beginTurn(ask);
  const unsaved = await flushDraftEdits();
  if (ctl.signal.aborted) return;
  const answerId = useJarvis.getState().log.at(-1)?.id ?? "";
  const chunker = createSentenceChunker();
  let streamed = false;
  // Asked to hide: done once this answer is spoken, instead of a follow-up —
  // unless the answer offered a draft, whose "Send it?" needs the reply.
  let hide = false;
  let drafted = false;
  // Asked to start over: the panel's "New", once this answer is spoken.
  let fresh = false;
  const ui = useUiState.getState();
  try {
    await jarvisTurn(
      session(),
      {
        text: ask,
        // Re-read after the save's await: the store is not the snapshot's.
        conversation_id: useJarvis.getState().conversationId,
        context: ui.view.kind === "channel" && ui.sel.c ? { channel_id: ui.sel.c, thread_id: ui.threadRoot } : undefined,
        unsaved_drafts: unsaved.length ? unsaved : undefined,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      event => {
        if (ctl.signal.aborted) return;
        if (event.type === "delta") jarvisLevel.bump();
        else if (event.type === "status" && event.phase !== "speaking") jarvisLevel.bump(0.12);
        useJarvis.getState().applyEvent(event);
        if (event.type === "draft_sent") onDraftSent(event.draft_id, event.message.id, event.already_sent === true);
        // Closed meanwhile: the answer may finish speaking, but it doesn't
        // move the user somewhere else while they're doing something.
        if (event.type === "navigate" && caps.open) jumpTo(event);
        if (event.type === "hide") hide = true;
        if (event.type === "new_conversation") fresh = true;
        // The server reported a failure: keep the panel (and the error) up.
        if (event.type === "error") hide = fresh = false;
        if (event.type === "card" && event.card.kind === "draft") drafted = true;
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
    hide = false; // keep the panel up to show what went wrong
    fresh = false;
    useJarvis.getState().failTurn(turnFailure(e));
  } finally {
    if (turnAbort === ctl) turnAbort = null;
  }
  afterTurn(hide && !drafted, fresh && !drafted);
}

/** Once the answer has been spoken, listen for a follow-up (or rest) — or,
    when the turn asked to hide, close the panel. Closing only hides it:
    Jarvis mode (`enabled`) is never touched, so the wake word re-arms once
    the panel releases the mic. A newer turn replaces this callback, so a
    hide never lands after the user has moved on. */
function afterTurn(hide = false, fresh = false): void {
  whenSpeechDrained(() => {
    if (useJarvis.getState().busy) return;
    if (fresh && caps.api) newConversation(caps.api);
    if (hide) {
      stopListening();
      if (useJarvis.getState().phase === "speaking") useJarvis.getState().setVoicePhase(null);
      useJarvis.getState().close();
      return;
    }
    // After "Stop speaking" the user is reading: no follow-up capture.
    if (canListen() && caps.open && !turnQuiet) {
      if (useJarvis.getState().phase === "speaking") useJarvis.getState().setVoicePhase(null);
      void listen("followUp");
    } else {
      stopListening();
      if (useJarvis.getState().phase === "speaking") useJarvis.getState().setVoicePhase(null);
    }
  });
}

/** The panel closed: stop listening (dropping any recording, and any
    transcription still in flight) but let the answer finish streaming and
    speaking. Jarvis mode and the wake word are untouched. */
export function panelClosed(): void {
  caps.open = false;
  stopListening();
}

/** "Stop speaking": silence the rest of this answer now, including clips
    still being synthesized, while its text and cards keep streaming; no
    follow-up capture. The next turn speaks again. Not the Sound setting. */
export function stopSpeaking(): void {
  turnQuiet = true;
  turnSilenced = true;
  useJarvis.setState({ speechStopped: true });
  // Run what waited on the speech (rest, hide, or start over) now, as the
  // Sound toggle does; mid-stream, the turn's own end runs it instead.
  const then = speech.drained;
  stopSpeech();
  if (then) then();
  else if (useJarvis.getState().phase === "speaking") useJarvis.getState().setVoicePhase(null);
}

/** Stop everything (sign-out, lost access, Jarvis mode switched off). */
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
  discardWaitingAudio();
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
  syncAudio();
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
    syncAudio();
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
  // Features → Jarvis speaking speed, read per clip: a change applies from
  // the next sentence. Pitch is kept so faster isn't squeakier.
  el.preservesPitch = true;
  (el as HTMLAudioElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;
  el.defaultPlaybackRate = caps.rate;
  el.playbackRate = caps.rate;
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
  syncAudio();
}

function syncAudio(): void {
  const active = speech.playing || speech.queue.length > 0;
  if (useJarvis.getState().audioActive !== active) useJarvis.setState({ audioActive: active });
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
