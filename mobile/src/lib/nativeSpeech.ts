/* Manual, on-device message speech. This is deliberately separate from
   speech.ts: automatic agent replies use authenticated server-generated
   audio, while a user-selected message should work without server TTS. */

import * as Speech from "expo-speech";
import { create } from "zustand";
import type { Message } from "@agora/core";
import { stopSpeech } from "./speech";

/** Whether a manual Speak is in progress — drives the app-wide Stop banner. */
export const useNativeSpeech = create<{ speaking: boolean }>(() => ({ speaking: false }));

/** Bumped by every Speak and Stop, so a superseded utterance's late
    onDone/onStopped can't hide the banner for the one now playing. */
let utterance = 0;

function finish(id: number): void {
  if (id === utterance) useNativeSpeech.setState({ speaking: false });
}

/** Speak the complete stored message, regardless of whether its TL;DR is
    currently displayed. Returns false when the message has no spoken text. */
export async function speakMessage(
  message: Pick<Message, "text">,
  onError?: (error: Error) => void,
): Promise<boolean> {
  if (!message.text.trim()) return false;

  const id = ++utterance;
  useNativeSpeech.setState({ speaking: true });
  try {
    // Never let server audio and the system synthesizer talk over each other.
    stopSpeech();
    await Speech.stop();
    if (id !== utterance) return true; // stopped (or replaced) while waiting
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
  void Speech.stop().catch(() => {});
}
