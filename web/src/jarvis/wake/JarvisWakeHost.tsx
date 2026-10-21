/* Arms the on-device wake word while Jarvis mode is on, and opens the
   assistant panel on each detection. Mounted once by AgoraLayout; renders
   nothing.

   The phrase is "Hey Jarvis" for now: the Hey Agora model fires on too many
   near-miss phrases to ship (docs/JARVIS_WAKE.md), and stays behind the
   ?wakeDebug=1 harness until it is retrained. */

import { useEffect, useRef } from "react";
import { useMe } from "@agora/core";
import { playChime } from "../../lib/chime";
import { useJarvis } from "../../state/jarvis";
import { useLiveVoice } from "../../state/liveVoice";
import { createWakeDetector, WAKE_MODELS, type WakeDetector } from "./detector";

export const JARVIS_WAKE_MODEL = WAKE_MODELS.hey_jarvis;

export function JarvisWakeHost() {
  const me = useMe().data;
  const available = me?.jarvis === true;
  const voiceIn = me?.jarvis_stt === true;
  const enabled = useJarvis(s => s.enabled);
  // Live voice owns the mic while a session runs; a wake mid-session would
  // open the panel over it.
  const liveActive = useLiveVoice(s => s.scope !== null);
  // The panel's voice loop holds its own capture while a conversation runs.
  const micOwned = useJarvis(s => s.micOwned);
  const on = available && enabled;
  const wakeRef = useRef<WakeDetector | null>(null);
  const voiceInRef = useRef(false);

  useEffect(() => {
    if (!on) {
      useJarvis.getState().setWake("off");
      return;
    }
    let disposed = false;
    const detector: WakeDetector = createWakeDetector({
      model: JARVIS_WAKE_MODEL,
      onWake: () => {
        const st = useJarvis.getState();
        if (!st.enabled) return;
        // The voice loop chimes when it starts listening; without it (mic
        // muted, no STT) the chime still confirms the wake was heard.
        if (st.micMuted || !voiceInRef.current) playChime(0.5);
        st.open();
      },
      onError: (message) => { if (!disposed) useJarvis.getState().setWake("error", message); },
      // WebKit can hold the audio until a gesture ("Audio is paused…").
      onResume: () => { if (!disposed) useJarvis.getState().setWake("listening"); },
    });
    wakeRef.current = detector;
    useJarvis.getState().setWake("starting");
    detector.start().then(
      () => {
        if (disposed) return;
        detector.setArmed(!useLiveVoice.getState().scope && !useJarvis.getState().micOwned);
        // Keep an error raised during start (e.g. audio paused) on the chip.
        if (useJarvis.getState().wake === "starting") useJarvis.getState().setWake("listening");
      },
      (err: unknown) => {
        if (disposed) return;
        const denied = err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError");
        const missing = err instanceof DOMException && err.name === "NotFoundError";
        useJarvis.getState().setWake("error", denied
          ? "Microphone access is off. Allow it for Agora to use the wake word."
          : missing ? "No microphone found for the wake word."
          : (err as Error)?.message || "The wake word could not start.");
      },
    );
    return () => {
      disposed = true;
      wakeRef.current = null;
      detector.stop();
    };
  }, [on]);

  useEffect(() => { voiceInRef.current = voiceIn; }, [voiceIn]);
  useEffect(() => { wakeRef.current?.setArmed(!liveActive && !micOwned); }, [liveActive, micOwned]);

  return null;
}
