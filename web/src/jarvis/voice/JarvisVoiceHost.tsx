/* Keeps the voice loop configured while the assistant panel is closed, so a
   reply can finish speaking in the background. Mounted once by
   AgoraLayout; renders nothing. Stops everything when the answer must not
   go on: signing out (unmount), losing Jarvis access, or switching Jarvis
   mode off. */

import { useEffect, useRef } from "react";
import { useApi, useMe } from "@agora/core";
import { useJarvis } from "../../state/jarvis";
import { closeVoice, configureVoice, silenceSpeech } from "./conversation";

export function JarvisVoiceHost() {
  const me = useMe().data;
  const api = useApi();
  const available = me?.jarvis === true;
  const stt = me?.jarvis_stt === true;
  const tts = me?.jarvis_tts === true;
  const rate = typeof me?.jarvis_speech_rate === "number" && me.jarvis_speech_rate > 0 ? me.jarvis_speech_rate : 1;
  const enabled = useJarvis(s => s.enabled);
  const speakerOff = useJarvis(s => s.speakerOff);

  useEffect(() => { configureVoice({ api, stt, tts, rate }); }, [api, stt, tts, rate]);
  // The Sound toggle can go off while hidden too: finish silently.
  useEffect(() => { if (speakerOff) silenceSpeech(); }, [speakerOff]);
  useEffect(() => { if (!available) closeVoice(); }, [available]);
  // Only the switch going off stops a reply, and only one going on in the
  // background: in an open panel (typed use) the answer carries on.
  const wasEnabled = useRef(enabled);
  useEffect(() => {
    if (wasEnabled.current && !enabled && !useJarvis.getState().isOpen) closeVoice();
    wasEnabled.current = enabled;
  }, [enabled]);
  useEffect(() => () => closeVoice(), []);
  return null;
}
