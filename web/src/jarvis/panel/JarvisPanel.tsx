/* The Agora assistant panel (Jarvis mode): a voice conversation with a
   typed fallback. Floating bottom-center: a thinking orb mapped from the
   phase, the session transcript (the current answer streams in, with the
   sentence being spoken highlighted), the card stack, mic / speaker
   toggles, and an optional text input. The voice loop itself lives in
   ../voice/conversation.ts; the VoiceBeam along the bottom edge follows the
   mic while listening and the playback while speaking (`jarvisLevel`). */

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ThinkingOrb } from "thinking-orbs";
import { VoiceBeam } from "voice-glow";
import { useApi, useMe } from "@agora/core";
import { Icon } from "../../lib/icons";
import { useAppearance } from "../../state/appearance";
import { useJarvis, type JarvisLogEntry } from "../../state/jarvis";
import { useLiveVoice } from "../../state/liveVoice";
import {
  abortTurn, closeVoice, configureVoice, listen, runTurn, silenceSpeech, stopListening,
} from "../voice/conversation";
import { JarvisCardView } from "./JarvisCards";
import { jarvisLevel } from "./level";
import { orbLook, phaseLabel } from "./orbState";

export { jarvisLevel };

function usePrefersReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(query);
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

export function JarvisPanel() {
  const me = useMe().data;
  const isOpen = useJarvis(s => s.isOpen);
  if (!me?.jarvis || !isOpen) return null;
  return <OpenPanel />;
}

function LogLine({ entry, spoken, streaming }: {
  entry: JarvisLogEntry;
  spoken: { start: number; end: number } | null;
  streaming: boolean;
}) {
  const text = entry.text;
  const body = spoken && spoken.end <= text.length
    ? <>{text.slice(0, spoken.start)}<mark className="jv-spoken">{text.slice(spoken.start, spoken.end)}</mark>{text.slice(spoken.end)}</>
    : text;
  return (
    <div className={`jv-line is-${entry.role}${streaming ? " is-streaming" : ""}`}>
      <span className="jv-who">{entry.role === "user" ? "You" : "Agora"}</span>
      <span className="jv-said">{body}</span>
    </div>
  );
}

function OpenPanel() {
  const s = useJarvis();
  const me = useMe().data;
  const api = useApi();
  const theme = useAppearance(a => a.resolved);
  const reduced = usePrefersReducedMotion();
  const liveActive = useLiveVoice(st => st.scope !== null);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const stt = me?.jarvis_stt === true;
  const tts = me?.jarvis_tts === true;

  // The voice loop follows the panel: open while mounted, closed on unmount
  // (StrictMode's dev remount included). Effects run in order, so this is
  // configured before the listen effects below fire.
  useEffect(() => { configureVoice({ api, stt, tts }); }, [api, stt, tts]);
  useEffect(() => {
    configureVoice({ open: true });
    return () => { configureVoice({ open: false }); closeVoice(); };
  }, []);

  // open() (chip, shortcut, wake word) asks to listen; open(text) queues a typed turn.
  const listenSeq = s.listenSeq;
  const pendingAsk = s.pendingAsk;
  useEffect(() => {
    if (useJarvis.getState().pendingAsk) return; // the queued turn runs instead
    void listen("open");
  }, [listenSeq]);
  useEffect(() => {
    const ask = useJarvis.getState().takePendingAsk();
    if (ask) void runTurn(ask);
  }, [pendingAsk]);

  const firstMute = useRef(true);
  useEffect(() => {
    if (firstMute.current) { firstMute.current = false; return; }
    if (s.micMuted) stopListening();
    else void listen("open");
  }, [s.micMuted]);
  useEffect(() => { if (s.speakerOff) silenceSpeech(); }, [s.speakerOff]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [s.log]);

  useEffect(() => {
    inputRef.current?.focus();
    // Capture phase so Esc closes the panel before the app's own Esc
    // shortcuts (mark read, close thread) see it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const active = document.activeElement;
      if (active && active !== document.body && !rootRef.current?.contains(active)) return;
      event.preventDefault();
      event.stopPropagation();
      useJarvis.getState().close();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (s.busy) return;
    const ask = text;
    setText("");
    void runTurn(ask);
  };

  const look = orbLook(s.phase);
  const listening = s.phase === "listening" || s.phase === "recording";
  const status = s.error ? s.error
    : s.label || (s.phase === "listening" ? "Listening — just talk" : phaseLabel(s.phase));
  const admin = me?.instance_admin === true;
  const micTitle = !stt
    ? (admin ? "Voice input isn't set up — add a speech-to-text key in Settings → AI. Type instead."
      : "Voice input isn't set up on this server — type instead.")
    : liveActive ? "Live voice is using the microphone"
    : s.micMuted ? "Mic off — type instead" : "Mic on — Agora listens for you (click to mute)";
  const speakerTitle = !tts
    ? (admin ? "Spoken replies aren't set up — add a text-to-speech key in Settings → AI. Text only."
      : "Spoken replies aren't set up on this server — text only.")
    : s.speakerOff ? "Speaker off — replies are text only" : "Speaker on — replies are spoken (click for text only)";
  const lastId = s.log.at(-1)?.id;
  const panel = (
    <div className={`jv-panel phase-${s.phase}`} ref={rootRef} role="dialog" aria-label="Agora assistant" data-testid="jarvis-panel">
      {s.cards.length > 0 && (
        <div className="jv-cards" aria-live="polite">
          {s.cards.map(entry => <JarvisCardView key={entry.id} entry={entry} />)}
        </div>
      )}
      <div className="jv-main">
        <div className="jv-orb" aria-hidden="true">
          <ThinkingOrb state={look.state} size={64} paused={look.paused || reduced} theme={theme} />
        </div>
        <div className="jv-copy">
          <div className={`jv-status${s.error ? " is-error" : ""}`} aria-live="polite" data-testid="jarvis-status">{status}</div>
          <div className="jv-log" ref={logRef} aria-live="polite" data-testid="jarvis-log">
            {s.log.length === 0 && (
              <div className="jv-hint">{stt && !s.micMuted
                ? "Say “catch me up” or “tell Claude in #release to rerun the deploy”."
                : "Try “catch me up” or “tell Claude in #release to rerun the deploy”."}</div>
            )}
            {s.log.map(entry => (
              <LogLine key={entry.id} entry={entry}
                spoken={s.spoken?.id === entry.id ? s.spoken : null}
                streaming={s.busy && entry.id === lastId && entry.role === "assistant"} />
            ))}
          </div>
        </div>
        <div className="jv-head-actions">
          <button type="button" className={`jv-toggle${!stt ? " is-unavailable" : s.micMuted ? " is-off" : listening ? " is-live" : ""}`}
            aria-label="Microphone" aria-pressed={stt && !s.micMuted} aria-disabled={!stt} title={micTitle}
            data-testid="jarvis-mic"
            onClick={() => { if (stt) useJarvis.getState().setMicMuted(!s.micMuted); }}>
            <Icon name={stt && !s.micMuted ? "mic" : "mic-off"} />
          </button>
          <button type="button" className={`jv-toggle${!tts ? " is-unavailable" : s.speakerOff ? " is-off" : s.phase === "speaking" ? " is-live" : ""}`}
            aria-label="Speaker" aria-pressed={tts && !s.speakerOff} aria-disabled={!tts} title={speakerTitle}
            data-testid="jarvis-speaker"
            onClick={() => { if (tts) useJarvis.getState().setSpeakerOff(!s.speakerOff); }}>
            <Icon name={tts && !s.speakerOff ? "volume-2" : "volume-x"} />
          </button>
          {(s.conversationId || s.cards.length > 0 || s.log.length > 0) && (
            <button className="btn sm" title="Start over" onClick={() => { abortTurn(); useJarvis.getState().reset(); }}>New</button>
          )}
          <button className="jv-close" aria-label="Close assistant (Esc)" onClick={() => useJarvis.getState().close()}><Icon name="x" /></button>
        </div>
      </div>
      <form className="jv-input" onSubmit={submit}>
        <input ref={inputRef} value={text} onChange={e => setText(e.target.value)} maxLength={4000}
          placeholder={s.busy ? "Working…" : listening ? "Or type…" : "Ask Agora…"} aria-label="Ask Agora" />
        <button className="btn sm primary" type="submit" disabled={s.busy || !text.trim()}>Ask</button>
      </form>
    </div>
  );
  return (
    <div className="jv-dock">
      {reduced ? panel : (
        <VoiceBeam level={jarvisLevel.get} theme={theme} idle={s.busy || listening ? 0.3 : 0.12} className="jv-beam">
          {panel}
        </VoiceBeam>
      )}
    </div>
  );
}
