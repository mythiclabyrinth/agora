/* Voice-note recorder (🎙 in the composers): click to
   record, click again to stop-and-send; the audio is uploaded to /voice,
   transcribed server-side, and posted as a normal text message. Nothing is
   stored as audio. One recording at a time across all composers. */

import { create } from "zustand";
import { threadAddressKey } from "@agora/core";
import { recMime, uploadVoice, voiceSupported } from "../lib/voice";
import { toast } from "../lib/toast";
import { useRequireAgent } from "./requireAgent";

const recKey = (channelId: string, threadId: number | null) =>
  threadId != null ? `t:${threadId}` : `c:${channelId}`;

interface RecSession {
  key: string;
  channelId: string;
  threadId: number | null;
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  canceled: boolean;
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

async function start(channelId: string, threadId: number | null): Promise<void> {
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
    recorder, stream, chunks: [], canceled: false, startedAt: Date.now(),
  };
  recorder.ondataavailable = e => { if (e.data && e.data.size) session.chunks.push(e.data); };
  recorder.onstop = () => {
    stream.getTracks().forEach(t => t.stop());
    if (rec === session) rec = null;
    useVoiceRec.setState({ recordingKey: null, startedAt: 0 });
    if (!session.canceled && session.chunks.length) void upload(session);
  };
  rec = session;
  recorder.start();
  useVoiceRec.setState({ recordingKey: session.key, startedAt: session.startedAt });
}

async function upload(session: RecSession): Promise<void> {
  const type = (session.recorder.mimeType || "audio/webm").toLowerCase();
  const blob = new Blob(session.chunks, { type });
  useVoiceRec.setState({ busyKey: session.key });
  const requireAgent = session.threadId != null
    && useRequireAgent.getState().isOn(threadAddressKey(session.channelId, session.threadId));
  try {
    await uploadVoice({
      channelId: session.channelId,
      threadId: session.threadId,
      blob,
      mentions: session.mentions,
      requireAgent,
    });
    // The WS echo delivers the transcribed message.
  } catch (e) {
    toast("Voice message failed: " + (e as Error).message, { variant: "warn" });
  } finally {
    useVoiceRec.setState({ busyKey: null });
  }
}

function finish(send: boolean): void {
  if (!rec) return;
  rec.canceled = !send;
  try { rec.recorder.stop(); } catch {
    rec = null;
    useVoiceRec.setState({ recordingKey: null, startedAt: 0 });
  }
}

export function voiceCancel(): void { finish(false); }

export async function voiceToggle(
  channelId: string,
  threadId: number | null,
  mentions?: string,
): Promise<void> {
  // Capture mentions at stop-and-send so mid-recording picker changes apply.
  if (rec && rec.key === recKey(channelId, threadId)) {
    rec.mentions = mentions;
    finish(true);
    return;
  }
  if (rec) finish(false); // one recording at a time
  await start(channelId, threadId);
}
