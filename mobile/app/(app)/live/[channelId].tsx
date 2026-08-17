/* Live voice: a hands-free, full-screen conversation loop for one channel —
   or, when opened from a thread, for that one thread (turns post as replies
   under the root) — the mobile counterpart of the web UI's 🎧 Live strip.

   Half-duplex cascade: the mic records continuously and a metering-based VAD
   (src/lib/vad.ts) endpoints each utterance; the clip goes to /voice?live=true
   (server transcribes and posts it; agents are steered to answer in spoken
   prose), and the reply is fetched from /speech and played. The mic stays off
   while audio plays — phone speakers feed the mic straight back, and expo-audio
   has no echo cancellation — so barge-in is "tap to interrupt" rather than
   talk-over. */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Stack, router, useLocalSearchParams } from "expo-router";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import { useKeepAwake } from "expo-keep-awake";
import { useChannelAgents } from "@agora/core";
import { useSendVoice } from "../../../src/api/voice";
import { LiveVoiceView, type LiveStatus } from "../../../src/components/LiveVoice";
import { toast } from "../../../src/components/Toast";
import { onAgentMessage } from "../../../src/lib/agentBus";
import { recordPositiveEvent } from "../../../src/lib/storeReview";
import { slugify } from "@agora/core";
import {
  enqueueSpeech,
  onSpeechIdle,
  prepareSpeechAudio,
  stopSpeech,
} from "../../../src/lib/speech";
import { initialVadState, vadCanSend, vadStep } from "../../../src/lib/vad";
import { threadAddressKey, useAddressed } from "@agora/core";
import { useSession } from "../../../src/state/session";

/** A silent listening stretch longer than this recycles the recorder so idle
    sessions don't accumulate a huge file between utterances. */
const IDLE_RECYCLE_MS = 45_000;
const TURN_TIMEOUT_MS = 60_000; // same safety valve as the web loop

export default function LiveScreen() {
  const params = useLocalSearchParams<{
    channelId: string;
    channelName?: string;
    rootId?: string;
    rootSnippet?: string;
  }>();
  const channelId = params.channelId;
  // Thread-scoped session: turns post as replies under this root, and only
  // that thread's agent replies close the turn (same rule as the web UI).
  const threadId = params.rootId ? Number(params.rootId) : null;
  const session = useSession((s) => s.session)!;
  const sendVoice = useSendVoice(channelId);
  useKeepAwake();

  /* The conversation's "talk to" selection (set in the composer) also
     addresses live turns: the transcript gets the same "@a, @b" prefix a
     typed message would, so mention routing reaches the tagged agents. */
  const addressKey = threadId != null ? threadAddressKey(channelId, threadId) : channelId;
  const addressedIds = useAddressed((s) => s.byConvo[addressKey]);
  const channelAgents = useChannelAgents(channelId);
  const mentionPrefix = React.useMemo(() => {
    if (!addressedIds?.length) return undefined;
    const prefix = (channelAgents.data ?? [])
      .filter((a) => addressedIds.includes(a.id))
      .map((a) => `@${slugify(a.name)}`)
      .join(", ");
    return prefix || undefined;
  }, [addressedIds, channelAgents.data]);
  const mentionPrefixRef = useRef(mentionPrefix);
  mentionPrefixRef.current = mentionPrefix;

  const [status, setStatus] = useState<LiveStatus>("starting");
  const statusRef = useRef(status);
  statusRef.current = status;
  const [muted, setMuted] = useState(false);
  const [muteBusy, setMuteBusy] = useState(false);
  const mutedRef = useRef(false);
  const muteBusyRef = useRef(false);

  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  });
  const recorderState = useAudioRecorderState(recorder, 120);

  const vad = useRef(initialVadState());
  const ended = useRef(false);
  const turnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveStartedAt = useRef(Date.now());
  const liveErrored = useRef(false);

  /* -------------------------------------------------- mic control */

  const startMic = useCallback(async () => {
    if (ended.current) return;
    if (mutedRef.current) {
      setStatus("listening");
      return;
    }
    try {
      // Background flags keep the session alive when the phone locks mid-
      // conversation: the mic (foreground service on Android, background
      // audio session on iOS) and the TTS replies both survive the lock.
      await setAudioModeAsync({
        allowsRecording: true,
        allowsBackgroundRecording: true,
        playsInSilentMode: true,
        shouldPlayInBackground: true,
      });
      if (ended.current || mutedRef.current) {
        try { await recorder.stop(); } catch { /* not recording */ }
        await setAudioModeAsync({
          allowsRecording: false,
          allowsBackgroundRecording: false,
          playsInSilentMode: true,
          shouldPlayInBackground: true,
        }).catch(() => {});
        if (!ended.current) setStatus("listening");
        return;
      }
      await recorder.prepareToRecordAsync();
      if (ended.current || mutedRef.current) {
        try { await recorder.stop(); } catch { /* not recording */ }
        await setAudioModeAsync({
          allowsRecording: false,
          allowsBackgroundRecording: false,
          playsInSilentMode: true,
          shouldPlayInBackground: true,
        }).catch(() => {});
        if (!ended.current) setStatus("listening");
        return;
      }
      recorder.record();
      vad.current = initialVadState();
      setStatus("listening");
    } catch {
      if (!ended.current) setStatus(mutedRef.current ? "listening" : "error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopMic = useCallback(async (): Promise<string | null> => {
    try {
      await recorder.stop();
    } catch {
      /* not recording */
    }
    return recorder.uri;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* -------------------------------------------------- session lifecycle */

  useEffect(() => {
    if (status === "error") liveErrored.current = true;
  }, [status]);

  useEffect(() => {
    ended.current = false;
    liveStartedAt.current = Date.now();
    liveErrored.current = false;
    void (async () => {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        liveErrored.current = true;
        setStatus("error");
        return;
      }
      await prepareSpeechAudio();
      await startMic();
    })();
    return () => {
      ended.current = true;
      if (turnTimer.current) clearTimeout(turnTimer.current);
      stopSpeech();
      // Clean end after ~30s of hands-free chat is a real value moment.
      if (
        !liveErrored.current &&
        Date.now() - liveStartedAt.current >= 30_000
      ) {
        void recordPositiveEvent();
      }
      void stopMic().then(() =>
        setAudioModeAsync({
          allowsRecording: false,
          allowsBackgroundRecording: false,
          playsInSilentMode: true,
          shouldPlayInBackground: true,
        }).catch(() => {}),
      );
    };
  }, [startMic, stopMic]);

  /* -------------------------------------------------- turn upload */

  const sendUtterance = useCallback(
    async (uri: string) => {
      setStatus("thinking");
      if (turnTimer.current) clearTimeout(turnTimer.current);
      // A channel with no live agents (or a dropped reply) must not wedge the
      // session in "thinking" forever.
      turnTimer.current = setTimeout(() => {
        if (!ended.current && statusRef.current === "thinking") void startMic();
      }, TURN_TIMEOUT_MS);
      try {
        await sendVoice.mutateAsync({
          file: { uri, name: `live-${Date.now()}.m4a`, type: "audio/m4a" },
          threadId,
          live: true,
          mentions: mentionPrefixRef.current,
        });
      } catch (e) {
        if (ended.current) return;
        toast(e instanceof Error ? e.message : "Voice turn failed", "warn");
        if (turnTimer.current) clearTimeout(turnTimer.current);
        void startMic();
      }
    },
    [sendVoice, startMic, threadId],
  );

  /* Mute is also an explicit end-of-turn control: if speech is in progress,
     stop and send it immediately so background noise cannot keep VAD open. */
  const toggleMute = useCallback(async () => {
    if (muteBusyRef.current) return;
    muteBusyRef.current = true;
    setMuteBusy(true);
    try {
      if (mutedRef.current) {
        mutedRef.current = false;
        setMuted(false);
        if (statusRef.current === "listening" || statusRef.current === "recording") {
          await startMic();
        }
        return;
      }

      mutedRef.current = true;
      setMuted(true);
      const previousStatus = statusRef.current;
      const wasRecording = previousStatus === "recording";
      const sendable = wasRecording && vadCanSend(vad.current);
      if (previousStatus === "listening" || wasRecording) setStatus("listening");
      const uri = await stopMic();
      await setAudioModeAsync({
        allowsRecording: false,
        allowsBackgroundRecording: false,
        playsInSilentMode: true,
        shouldPlayInBackground: true,
      }).catch(() => {});
      if (!ended.current && sendable && uri) await sendUtterance(uri);
    } finally {
      muteBusyRef.current = false;
      if (!ended.current) setMuteBusy(false);
    }
  }, [sendUtterance, startMic, stopMic]);

  /* -------------------------------------------------- VAD loop
     Runs on every metering poll (~120ms). Only the listening/recording
     states feed the endpointer; thinking/speaking keep the mic stopped. */

  useEffect(() => {
    const st = statusRef.current;
    if (ended.current || mutedRef.current || (st !== "listening" && st !== "recording")) return;
    const action = vadStep(vad.current, recorderState.metering, Date.now());
    if (action.kind === "start") {
      setStatus("recording");
    } else if (action.kind === "end") {
      void (async () => {
        const uri = await stopMic();
        if (ended.current) return;
        if (action.sendable && uri) {
          await sendUtterance(uri);
        } else {
          await startMic(); // noise blip — arm a fresh recording
        }
      })();
    } else if (
      st === "listening" &&
      (recorderState.durationMillis ?? 0) > IDLE_RECYCLE_MS
    ) {
      void stopMic().then(() => startMic());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorderState]);

  /* -------------------------------------------------- agent replies
     Only replies in this session's scope close the turn and get spoken —
     channel sessions take top-level replies, thread sessions their thread's.
     Same scoping as the web session. */

  useEffect(() => {
    return onAgentMessage((m) => {
      if (ended.current || m.channel_id !== channelId) return;
      if ((m.thread_id ?? null) !== threadId) return;
      if (turnTimer.current) clearTimeout(turnTimer.current);
      void (async () => {
        await stopMic(); // half-duplex: never record our own playback
        await setAudioModeAsync({
          allowsRecording: false,
          allowsBackgroundRecording: false,
          playsInSilentMode: true,
          shouldPlayInBackground: true,
        }).catch(() => {});
        if (ended.current) return;
        setStatus("speaking");
        enqueueSpeech(session, m.id);
        onSpeechIdle(() => {
          if (!ended.current) void startMic();
        });
      })();
    });
  }, [channelId, threadId, session, startMic, stopMic]);

  /* -------------------------------------------------- UI */

  const interrupt = () => {
    if (statusRef.current !== "speaking") return;
    stopSpeech();
    void startMic();
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <LiveVoiceView
        channelLabel={params.channelName || channelId}
        threadSession={threadId != null}
        rootSnippet={params.rootSnippet}
        status={status}
        muted={muted}
        muteBusy={muteBusy}
        meteringDb={recorderState.metering ?? null}
        onInterrupt={interrupt}
        onToggleMute={() => void toggleMute()}
        onEnd={() => router.back()}
      />
    </>
  );
}
