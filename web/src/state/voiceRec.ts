/* Voice-note recorder (🎙 in the composers): a take can be discarded,
   transcribed into the draft, or transcribed and sent. Nothing is stored as
   audio. One recording at a time across all composers. */

import { create } from "zustand";
import { threadAddressKey } from "@agora/core";
import { recMime, transcribeVoice, uploadVoice, voiceSupported } from "../lib/voice";
import { toast } from "../lib/toast";
import { useRequireAgent } from "./requireAgent";
import { appendDraft } from "./drafts";

const recKey = (channelId: string, threadId: number | null) =>
  threadId != null ? `t:${threadId}` : `c:${channelId}`;

interface RecSession {
  key: string;
  channelId: string;
  threadId: number | null;
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  finishMode: "cancel" | "send" | "draft" | null;
  draftOK: boolean;
  startedAt: number;
  /** "Talk to" prefix captured at stop-and-send (not at record start). */
  mentions?: string;
}

let rec: RecSession | null = null;

interface VoiceRecState {
  /** Composer key while recording, else null. */
  recordingKey: string | null;
  startedAt: number;
  /** Composer key while an upload/transcription is in flight. */
  busyKey: string | null;
}

export const useVoiceRec = create<VoiceRecState>(() => ({
  recordingKey: null,
  startedAt: 0,
  busyKey: null,
}));

export { recKey as voiceRecKey };

async function start(channelId: string, threadId: number | null, draftOK: boolean): Promise<void> {
  if (!voiceSupported()) {
    toast("Voice input isn't supported in this browser", { variant: "warn" });
    return;
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast("Microphone blocked — allow mic access to send voice messages", { variant: "warn" });
    return;
  }
  const mime = recMime();
  const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  const session: RecSession = {
    key: recKey(channelId, threadId), channelId, threadId,
    recorder, stream, chunks: [], finishMode: null, draftOK, startedAt: Date.now(),
  };
  recorder.ondataavailable = e => { if (e.data && e.data.size) session.chunks.push(e.data); };
  recorder.onstop = () => {
    stream.getTracks().forEach(t => t.stop());
    if (rec === session) rec = null;
    useVoiceRec.setState({ recordingKey: null, startedAt: 0 });
    if ((session.finishMode === "send" || session.finishMode === "draft") && session.chunks.length) {
      void processRecording(session, session.finishMode);
    } else if (session.finishMode === null && session.chunks.length) {
      if (session.draftOK) {
        void processRecording(session, "draft");
      } else {
        toast("Recording stopped unexpectedly and was discarded", { variant: "warn" });
      }
    }
  };
  rec = session;
  recorder.start();
  useVoiceRec.setState({ recordingKey: session.key, startedAt: session.startedAt });
}

async function processRecording(session: RecSession, mode: "send" | "draft"): Promise<void> {
  const type = (session.recorder.mimeType || "audio/webm").toLowerCase();
  const blob = new Blob(session.chunks, { type });
  useVoiceRec.setState({ busyKey: session.key });
  const requireAgent = session.threadId != null
    && useRequireAgent.getState().isOn(threadAddressKey(session.channelId, session.threadId));
  try {
    if (mode === "draft") {
      const text = await transcribeVoice({
        channelId: session.channelId, threadId: session.threadId, blob,
      });
      appendDraft(session.key, text);
    } else {
      await uploadVoice({
        channelId: session.channelId,
        threadId: session.threadId,
        blob,
        mentions: session.mentions,
        requireAgent,
      });
      // The WS echo delivers the transcribed message.
    }
  } catch (e) {
    const action = mode === "draft" ? "Transcription" : "Voice message";
    toast(`${action} failed: ${(e as Error).message}`, { variant: "warn" });
  } finally {
    useVoiceRec.setState({ busyKey: null });
  }
}

function finish(mode: "cancel" | "send" | "draft", mentions?: string): void {
  if (!rec) return;
  rec.finishMode = mode;
  if (mode === "send") rec.mentions = mentions;
  try { rec.recorder.stop(); } catch {
    rec.stream.getTracks().forEach(track => track.stop());
    rec = null;
    useVoiceRec.setState({ recordingKey: null, startedAt: 0 });
  }
}

export function voiceCancel(): void { finish("cancel"); }
export function voiceSend(mentions?: string): void { finish("send", mentions); }
export function voiceToDraft(): void { finish("draft"); }

export async function voiceToggle(
  channelId: string,
  threadId: number | null,
  mentions?: string,
  draftOK = false,
): Promise<void> {
  // Capture mentions at stop-and-send so mid-recording picker changes apply.
  if (rec && rec.key === recKey(channelId, threadId)) {
    voiceSend(mentions);
    return;
  }
  if (rec) finish("cancel"); // one recording at a time
  await start(channelId, threadId, draftOK);
}
