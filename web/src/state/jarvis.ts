/* Jarvis mode (the Agora assistant) UI state.

   `enabled` is the per-device "Jarvis mode" toggle (persisted to
   localStorage `agora_jarvis_enabled`); JarvisWakeHost arms the wake word
   while it is on and reports the mic state in `wake`. `open()` is the single
   entry point the header chip, the shortcut, and the wake detector call —
   it also asks the voice loop to listen (`listenSeq`), and `open(text)`
   queues a typed turn. Everything else is the session: phase (drives the
   orb), the transcript log with the streamed answer, what is being spoken,
   and the card stack. `micMuted` / `speakerOff` are per-device. */

import { create } from "zustand";
import type { JarvisCard, JarvisEvent, JarvisServerPhase } from "@agora/core";

export type JarvisPhase = "idle" | "armed" | "listening" | "recording" | "transcribing" | JarvisServerPhase | "error";
/** Phases the voice loop sets between turns (`null` = back to resting). */
export type JarvisVoicePhase = "listening" | "recording" | "transcribing" | "speaking";

export interface JarvisLogEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface JarvisCardEntry {
  id: string;
  card: JarvisCard;
  /** Draft lifecycle as the UI sees it. */
  status?: "pending" | "sending" | "sent" | "cancelled" | "expired";
  /** A draft's body as edited in its card; what Send (or "send it") posts. */
  text?: string;
  /** When a draft card's server-side draft expires (ms since epoch). */
  expiresAt?: number;
}

const ENABLED_KEY = "agora_jarvis_enabled";
const MIC_MUTED_KEY = "agora_jarvis_mic_muted";
const SPEAKER_OFF_KEY = "agora_jarvis_speaker_off";
const MAX_CARDS = 12;
const MAX_LOG = 40;

function loadFlag(key: string): boolean {
  try { return localStorage.getItem(key) === "1"; } catch { return false; }
}
function saveFlag(key: string, on: boolean): void {
  try { localStorage.setItem(key, on ? "1" : "0"); } catch { /* private mode */ }
}
const loadEnabled = () => loadFlag(ENABLED_KEY);

export interface JarvisState {
  enabled: boolean;
  isOpen: boolean;
  phase: JarvisPhase;
  label: string;
  /** Last thing the user said or typed. */
  transcript: string;
  /** The assistant's streamed answer for the current turn. */
  caption: string;
  /** This session's turns, oldest first; the last assistant entry streams. */
  log: JarvisLogEntry[];
  /** The part of a log entry being spoken right now. */
  spoken: { id: string; start: number; end: number } | null;
  cards: JarvisCardEntry[];
  conversationId: string | null;
  error: string | null;
  busy: boolean;
  /** A turn queued by `open(text)`, consumed by the panel. */
  pendingAsk: string | null;
  /** The wake word's mic state while Jarvis mode is on (JarvisWakeHost). */
  wake: "off" | "starting" | "listening" | "error";
  wakeError: string | null;
  /** Mic off: no conversational listening, typed input only (per device). */
  micMuted: boolean;
  /** Replies stay text-only (per device). */
  speakerOff: boolean;
  /** Bumped by open(): the voice loop starts listening when it changes. */
  listenSeq: number;
  /** The voice loop holds the mic (the wake word stands down meanwhile). */
  micOwned: boolean;

  setEnabled: (on: boolean) => void;
  setMicMuted: (muted: boolean) => void;
  setSpeakerOff: (off: boolean) => void;
  setMicOwned: (owned: boolean) => void;
  /** Voice-loop phase between turns; null returns to resting (armed/idle). */
  setVoicePhase: (phase: JarvisVoicePhase | null) => void;
  setSpoken: (spoken: JarvisState["spoken"]) => void;
  /** An assistant line outside a model turn (e.g. "Sent to #release."). */
  say: (text: string) => string;
  /** A user line outside a model turn (e.g. a spoken "send it"). */
  heard: (text: string) => void;
  setWake: (wake: JarvisState["wake"], error?: string) => void;
  toggleEnabled: () => void;
  open: (ask?: string) => void;
  close: () => void;
  takePendingAsk: () => string | null;
  /** Forget the conversation and cards ("new chat"). */
  reset: () => void;
  beginTurn: (text: string) => void;
  applyEvent: (event: JarvisEvent) => void;
  failTurn: (message: string) => void;
  endTurn: () => void;
  setCardStatus: (id: string, status: JarvisCardEntry["status"]) => void;
  setCardText: (id: string, text: string) => void;
  dismissCard: (id: string) => void;
}

const restingPhase = (enabled: boolean): JarvisPhase => enabled ? "armed" : "idle";
let cardSeq = 0;
let logSeq = 0;
const entry = (role: JarvisLogEntry["role"], text: string): JarvisLogEntry => ({ id: `jl${++logSeq}`, role, text });
const pushLog = (log: JarvisLogEntry[], ...add: JarvisLogEntry[]) => [...log, ...add].slice(-MAX_LOG);
/** Replace the streaming (last, assistant) entry's text. */
function withAnswer(log: JarvisLogEntry[], text: (prev: string) => string): JarvisLogEntry[] {
  const last = log[log.length - 1];
  if (!last || last.role !== "assistant") return pushLog(log, entry("assistant", text("")));
  return [...log.slice(0, -1), { ...last, text: text(last.text) }];
}

export const useJarvis = create<JarvisState>((set, get) => ({
  enabled: loadEnabled(),
  isOpen: false,
  phase: restingPhase(loadEnabled()),
  label: "",
  transcript: "",
  caption: "",
  log: [],
  spoken: null,
  cards: [],
  conversationId: null,
  error: null,
  busy: false,
  pendingAsk: null,
  wake: "off",
  wakeError: null,
  micMuted: loadFlag(MIC_MUTED_KEY),
  speakerOff: loadFlag(SPEAKER_OFF_KEY),
  listenSeq: 0,
  micOwned: false,

  setMicMuted: (muted) => {
    saveFlag(MIC_MUTED_KEY, muted);
    set(s => ({
      micMuted: muted,
      // Muting drops a capture in progress; a running turn keeps its phase.
      phase: muted && !s.busy && (s.phase === "listening" || s.phase === "recording") ? restingPhase(s.enabled) : s.phase,
    }));
  },
  setSpeakerOff: (off) => {
    saveFlag(SPEAKER_OFF_KEY, off);
    set(s => ({ speakerOff: off, spoken: off ? null : s.spoken }));
  },
  setMicOwned: (owned) => set({ micOwned: owned }),
  setVoicePhase: (phase) => set(s => {
    if (s.busy && phase !== "speaking") return {};
    if (phase === null) return { phase: s.phase === "error" ? s.phase : restingPhase(s.enabled), label: "", spoken: null };
    if ((phase === "listening" || phase === "recording") && s.micMuted) return {};
    // A new utterance clears the last error; listening alone keeps it visible.
    return { phase, label: "", error: phase === "recording" ? null : s.error };
  }),
  setSpoken: (spoken) => set({ spoken }),
  say: (text) => {
    const e = entry("assistant", text);
    set(s => ({ log: pushLog(s.log, e), caption: text }));
    return e.id;
  },
  heard: (text) => set(s => ({ log: pushLog(s.log, entry("user", text)), transcript: text })),
  setWake: (wake, error) => set({ wake, wakeError: wake === "error" ? error || "The wake word stopped." : null }),
  setEnabled: (on) => {
    try { localStorage.setItem(ENABLED_KEY, on ? "1" : "0"); } catch { /* private mode */ }
    set(s => ({ enabled: on, phase: s.busy || s.phase === "error" ? s.phase : restingPhase(on) }));
  },
  toggleEnabled: () => get().setEnabled(!get().enabled),
  open: (ask) => set(s => ({
    isOpen: true,
    pendingAsk: ask?.trim() ? ask.trim() : s.pendingAsk,
    listenSeq: ask?.trim() ? s.listenSeq : s.listenSeq + 1,
  })),
  close: () => set({ isOpen: false }),
  takePendingAsk: () => {
    const ask = get().pendingAsk;
    if (ask) set({ pendingAsk: null });
    return ask;
  },
  reset: () => set(s => ({
    conversationId: null, cards: [], caption: "", transcript: "", error: null, label: "", log: [], spoken: null,
    phase: s.busy ? s.phase : restingPhase(s.enabled),
  })),
  beginTurn: (text) => set(s => ({
    busy: true, transcript: text, caption: "", error: null, phase: "thinking", label: "Thinking", spoken: null,
    log: pushLog(s.log, entry("user", text), entry("assistant", "")),
  })),
  applyEvent: (event) => set(s => {
    switch (event.type) {
      case "start": return { conversationId: event.conversation_id };
      case "status": return { phase: event.phase, label: event.label };
      case "tool": return { label: event.summary };
      case "delta": return {
        caption: s.caption + event.text, phase: "speaking",
        log: withAnswer(s.log, prev => prev + event.text),
      };
      case "card": {
        const entry: JarvisCardEntry = {
          id: `jc${++cardSeq}`, card: event.card,
          status: event.card.kind === "draft" ? "pending" : undefined,
          // Anchored to arrival, so reopening the panel can't restart the clock.
          expiresAt: event.card.kind === "draft" ? Date.now() + event.card.expires_in * 1000 : undefined,
        };
        // Newest first; a stack, not a log.
        return { cards: [entry, ...s.cards].slice(0, MAX_CARDS) };
      }
      case "done": return {
        conversationId: event.conversation_id, busy: false, label: "",
        caption: s.caption || event.text, phase: restingPhase(s.enabled),
        log: s.caption ? s.log : withAnswer(s.log, () => event.text),
      };
      case "error": return { busy: false, error: event.message, phase: "error", label: "", log: dropEmptyAnswer(s.log) };
      default: return {};
    }
  }),
  failTurn: (message) => set(s => ({ busy: false, error: message, phase: "error", label: "", log: dropEmptyAnswer(s.log) })),
  endTurn: () => set(s => s.busy ? { busy: false, phase: restingPhase(s.enabled), label: "", log: dropEmptyAnswer(s.log) } : {}),
  setCardStatus: (id, status) => set(s => ({ cards: s.cards.map(c => c.id === id ? { ...c, status } : c) })),
  setCardText: (id, text) => set(s => ({ cards: s.cards.map(c => c.id === id ? { ...c, text } : c) })),
  dismissCard: (id) => set(s => ({ cards: s.cards.filter(c => c.id !== id) })),
}));

function dropEmptyAnswer(log: JarvisLogEntry[]): JarvisLogEntry[] {
  const last = log[log.length - 1];
  return last && last.role === "assistant" && !last.text ? log.slice(0, -1) : log;
}
