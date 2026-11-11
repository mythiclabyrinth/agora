/* Manual, on-device message speech. This is deliberately separate from
   speech.ts: automatic agent replies use authenticated server-generated
   audio, while a user-selected message should work without server TTS. */

import * as Speech from "expo-speech";
import { AppState, type NativeEventSubscription } from "react-native";
import { create } from "zustand";
import type { Message } from "@agora/core";
import { stopSpeech } from "./speech";

/** Whether a manual Speak is in progress — drives the app-wide Stop banner. */
export const useNativeSpeech = create<{ speaking: boolean }>(() => ({ speaking: false }));

/** Bumped by every Speak and Stop, so a superseded utterance's late
    onDone/onStopped can't hide the banner for the one now playing. */
let utterance = 0;

/** The synthesizer can drop an utterance without any callback (no voice,
    an interruption before it starts, JS suspended), which would pin the
    banner to every screen. While speaking, ask it directly now and then. */
const RECONCILE_INTERVAL_MS = 2_500;
/** Right after speak() the synthesizer may not report speaking yet. */
const START_GRACE_MS = 1_500;
let startedAt = 0;
let poll: ReturnType<typeof setInterval> | null = null;
let foreground: NativeEventSubscription | null = null;

function finish(id: number): void {
  if (id !== utterance) return;
  useNativeSpeech.setState({ speaking: false });
  unwatch();
}

async function reconcile(): Promise<void> {
  const id = utterance;
  if (!useNativeSpeech.getState().speaking || Date.now() - startedAt < START_GRACE_MS) return;
  let talking: boolean;
  try {
    talking = await Speech.isSpeakingAsync();
  } catch {
    return; // can't tell; leave the banner (Stop still works)
  }
  if (!talking) finish(id); // a no-op if a newer Speak started meanwhile
}

function watch(): void {
  if (!poll) poll = setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);
  foreground ??= AppState.addEventListener("change", (state) => {
    if (state === "active") void reconcile();
  });
}

function unwatch(): void {
  if (poll) clearInterval(poll);
  poll = null;
  foreground?.remove();
  foreground = null;
}

/** Speak the complete stored message, regardless of whether its TL;DR is
    currently displayed. Returns false when the message has no spoken text,
    true otherwise (including when it was stopped or replaced before the
    synthesizer started). */
export async function speakMessage(
  message: Pick<Message, "text">,
  onError?: (error: Error) => void,
): Promise<boolean> {
  if (!message.text.trim()) return false;

  const id = ++utterance;
  startedAt = Date.now();
  useNativeSpeech.setState({ speaking: true });
  watch();
  try {
    // Never let server audio and the system synthesizer talk over each other.
    stopSpeech();
    await Speech.stop();
    if (id !== utterance) return true; // stopped (or replaced) while waiting
    startedAt = Date.now();
    Speech.speak(message.text, {
      useApplicationAudioSession: false,
      onDone: () => finish(id),
      onStopped: () => finish(id),
      onError: (error) => {
        finish(id);
        onError?.(error);
      },
    });
  } catch (error) {
    // No callback will ever fire for a speak that never started.
    finish(id);
    throw error;
  }
  return true;
}

/** Stop a manual Speak now (the banner's Stop button). */
export function stopNativeSpeech(): void {
  utterance++;
  useNativeSpeech.setState({ speaking: false });
  unwatch();
  void Speech.stop().catch(() => {});
}
