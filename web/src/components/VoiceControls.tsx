/* Voice UI: the composer mic button (record → stop-and-send / discard),
   the channel-header speak-aloud and Live buttons, and the live-session
   strip. */

import { useEffect, useState } from "react";
import { Icon } from "../lib/icons";
import { useVoiceRec, voiceCancel, voiceRecKey, voiceToggle } from "../state/voiceRec";
import { liveLabel, liveMuteToggle, liveScopeActive, liveToggle, useLiveVoice } from "../state/liveVoice";
import { useSpeak } from "../state/speak";

function RecTimer({ startedAt }: { startedAt: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force(n => n + 1), 250);
    return () => clearInterval(t);
  }, []);
  const s = Math.floor((Date.now() - startedAt) / 1000);
  return <span className="ago-rec-time">{Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}</span>;
}

export function MicButton({ channelId, threadId }: { channelId: string; threadId: number | null }) {
  const { recordingKey, startedAt, busyKey } = useVoiceRec();
  const key = voiceRecKey(channelId, threadId);
  if (busyKey === key) {
    return (
      <button className="btn ago-mic busy" disabled title="Transcribing…">
        <span className="ago-rec-dots">…</span>
      </button>
    );
  }
  if (recordingKey === key) {
    return (
      <>
        <button className="btn ago-mic cancel" title="Discard recording" onClick={() => voiceCancel()}>
          <Icon name="x" />
        </button>
        <button className="btn ago-mic recording" title="Stop and send"
          onClick={() => void voiceToggle(channelId, threadId)}>
          <Icon name="square" cls="fill" />&nbsp;<RecTimer startedAt={startedAt} />
        </button>
      </>
    );
  }
  return (
    <button className="btn ago-mic" title="Record a voice message"
      onClick={() => void voiceToggle(channelId, threadId)}>
      <Icon name="mic" />
    </button>
  );
}

export function SpeakButton() {
  const { on, toggle } = useSpeak();
  return (
    <button className={`btn sm ago-speak-btn ${on ? "active" : ""}`}
      title={on
        ? "Stop speaking agent replies aloud"
        : "Speak agent replies aloud (applies to every channel)"}
      onClick={toggle}>
      <Icon name={on ? "volume-2" : "volume-x"} />
    </button>
  );
}

export function LiveButton({ channelId, threadId }: { channelId: string; threadId: number | null }) {
  useLiveVoice(); // re-render on scope changes
  const active = liveScopeActive(channelId, threadId);
  return (
    <button className={`btn sm ago-live-btn ${active ? "active" : ""}`}
      title={active
        ? (threadId != null ? "End the live voice conversation in this thread" : "End the live voice conversation")
        : (threadId != null
          ? "Live voice in this thread: talk hands-free, turns post here"
          : "Live voice: talk hands-free and hear the replies")}
      onClick={() => void liveToggle(channelId, threadId)}>
      <Icon name="headphones" /><span className="ago-btn-label">Live</span>
    </button>
  );
}

export function LiveStrip({ channelId, threadId }: { channelId: string; threadId: number | null }) {
  const { state, muted } = useLiveVoice();
  const speakOn = useSpeak(s => s.on);
  if (!liveScopeActive(channelId, threadId)) return null;
  return (
    <div className={`ago-live-strip st-${state}${muted ? " muted" : ""}`} id="ago-live-strip">
      <span className="ago-live-dot"></span>
      <span className="ago-live-label">{liveLabel(state, speakOn, muted)}</span>
      <button className={`btn sm ago-live-mute${muted ? " active" : ""}`}
        aria-pressed={muted}
        title={muted ? "Unmute microphone" : "Mute microphone and finish this turn"}
        onClick={liveMuteToggle}>
        <Icon name={muted ? "mic" : "mic-off"} /> {muted ? "Unmute" : "Mute"}
      </button>
      <button className="btn sm" onClick={() => void liveToggle(channelId, threadId)}>End</button>
    </div>
  );
}
