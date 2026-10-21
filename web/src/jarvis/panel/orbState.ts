/* Phase → thinking-orb animation. One table so the panel orb, the header
   chip, and tests agree on what each phase looks like. */

import type { OrbState } from "thinking-orbs";
import type { JarvisPhase } from "../../state/jarvis";

export interface OrbLook {
  state: OrbState;
  paused: boolean;
}

const LOOKS: Record<JarvisPhase, OrbLook> = {
  idle: { state: "breathing", paused: false },
  armed: { state: "breathing", paused: false },
  listening: { state: "listening", paused: false },
  recording: { state: "listening", paused: false },
  transcribing: { state: "solving", paused: false },
  thinking: { state: "solving", paused: false },
  searching: { state: "searching", paused: false },
  weaving: { state: "weaving", paused: false },
  composing: { state: "composing", paused: false },
  waiting: { state: "connecting", paused: false },
  speaking: { state: "shaping", paused: false },
  error: { state: "breathing", paused: true },
};

export function orbLook(phase: JarvisPhase): OrbLook {
  return LOOKS[phase] ?? LOOKS.idle;
}

/** Spoken-style status line under the orb when the server sent no label. */
export function phaseLabel(phase: JarvisPhase): string {
  switch (phase) {
    case "armed": return "Jarvis mode is on — ask me anything";
    case "listening": return "Listening";
    case "recording": return "Hearing you";
    case "transcribing": return "Transcribing";
    case "thinking": return "Thinking";
    case "searching": return "Reading";
    case "weaving": return "Summarizing";
    case "composing": return "Drafting";
    case "waiting": return "Waiting for a reply";
    case "speaking": return "Answering";
    case "error": return "Something went wrong";
    default: return "Ask me anything about your workspace";
  }
}
