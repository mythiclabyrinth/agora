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
  configureVoice, handleUtterance, listen, newConversation, panelClosed, runTurn, stopListening, stopSpeaking,
} from "../voice/conversation";
import { JarvisCardView } from "./JarvisCards";
import { jarvisLevel } from "./level";
import { splitCards, splitTurn } from "./derive";
import { orbLook, phaseLabel } from "./orbState";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

export { jarvisLevel };

/** One audio sample per frame goes directly to the halo, without rerendering
    the transcript. The animation stops when hidden, idle, or reduced-motion. */
function Presence({ phase, theme, reduced }: {
  phase: ReturnType<typeof useJarvis.getState>["phase"];
  theme: "dark" | "light";
  reduced: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const active = ["listening", "recording", "speaking"].includes(phase);
  useEffect(() => {
    if (reduced || !active) { ref.current?.style.removeProperty("--jv-level"); return; }
    let frame = 0;
    let last = 0;
    const paint = (now: number) => {
      if (now - last > 32 && !document.hidden) {
        ref.current?.style.setProperty("--jv-level", String(Math.max(0, Math.min(1, jarvisLevel.get()))));
        last = now;
      }
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [active, reduced]);
  const look = orbLook(phase);
  return <div className="jv-presence" ref={ref} aria-hidden="true">
    <div className="jv-aura" />
    <div className="jv-orbit" />
    <div className="jv-orb">
      <ThinkingOrb state={look.state} size={64} paused={look.paused || reduced} theme={theme} />
    </div>
    <span className="jv-orbit-point" />
  </div>;
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
  const followAnswer = useRef(true);
  const { history, current: currentLog } = splitTurn(s.log);
  const currentTurnId = currentLog[0]?.id;
  const stt = me?.jarvis_stt === true;
  const tts = me?.jarvis_tts === true;

  // Listening follows the panel: open while mounted; closing stops
  // listening but lets the answer finish speaking (StrictMode's dev remount
  // included). The rest of the voice configuration lives in JarvisVoiceHost.
  // Effects run in order, so this is set before the listen effects below.
  // Also set here (not only by the host), so a panel that mounts with the
  // first /api/me listens and speaks at once.
  useEffect(() => { configureVoice({ api, stt, tts }); }, [api, stt, tts]);
  useEffect(() => {
    configureVoice({ open: true });
    return () => panelClosed();
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

  useEffect(() => {
    // Reopening a completed exchange starts at its beginning. Only a new,
    // active turn follows the text; scrolling back pauses automatic following.
    followAnswer.current = useJarvis.getState().busy || useJarvis.getState().phase === "speaking";
  }, [currentTurnId]);
  useEffect(() => {
    const el = logRef.current;
    if (el && followAnswer.current) el.scrollTop = el.scrollHeight;
  }, [s.log]);
  useEffect(() => {
    const el = logRef.current;
    const mark = el?.querySelector(".jv-spoken");
    if (!el || !mark || !followAnswer.current) return;
    const line = mark.getBoundingClientRect();
    const viewport = el.getBoundingClientRect();
    if (line.top < viewport.top) el.scrollTop += line.top - viewport.top;
    else if (line.bottom > viewport.bottom) el.scrollTop += line.bottom - viewport.bottom;
  }, [s.spoken]);

  useEffect(() => {
    const previousFocus = document.activeElement;
    inputRef.current?.focus({ preventScroll: true });
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
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (s.busy) return;
    const ask = text;
    setText("");
    // A typed reply to a draft is judged by the server, as a spoken one is.
    void handleUtterance(ask);
  };

  const listening = s.phase === "listening" || s.phase === "recording";
  const status = s.error ? s.error
    : s.label || (s.phase === "listening" ? "Listening — just talk" : s.phase === "armed" && s.log.length > 0 ? "Ready when you are" : phaseLabel(s.phase));
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
  const hasConversation = s.log.length > 0;
  // Keep actionable drafts visible even when a later result arrives.
  const { primary: primaryCards, earlier: earlierCards } = splitCards(s.cards);
  const voiceHint = liveActive ? "Live voice is using the microphone"
    : s.micMuted ? (s.enabled ? "Conversation muted · wake word stays on" : "Conversation muted · type to continue")
    : !stt ? "Voice input is unavailable · type to continue"
    : s.phase === "speaking" && !s.speakerOff ? "You can speak to interrupt"
    : listening ? "I'm listening. Take your time."
    : s.enabled ? "Say “Hey Jarvis” to continue" : "Type a message, or turn on Jarvis mode";
  const choosePrompt = (prompt: string) => {
    setText(prompt);
    inputRef.current?.focus({ preventScroll: true });
  };
  const panel = (
    <div className={`jv-panel phase-${s.phase}${hasConversation ? " has-conversation" : ""}`}
      ref={rootRef} role="dialog" aria-label="Agora assistant" data-testid="jarvis-panel">
      <header className="jv-header">
        <div className="jv-identity"><span className="jv-brand-mark"><Icon name="sparkles" /></span>
          <span className="jv-brand">Agora<span className="jv-eyebrow">Your workspace assistant</span></span>
        </div>
        <div className="jv-head-actions">
          {(s.busy || s.phase === "speaking") && tts && !s.speakerOff && !s.speechStopped && (
            <button type="button" className="jv-stop" data-testid="jarvis-stop"
              title="Stop speaking — the text keeps coming" aria-label="Stop speaking"
              onClick={() => stopSpeaking()}>
              <Icon name="square" /><span>Stop speaking</span>
            </button>
          )}
          {(s.conversationId || s.cards.length > 0 || hasConversation) && (
            <button type="button" className="jv-new" title="Start a new conversation" onClick={() => newConversation(api)}>
              <Icon name="plus" /><span>New</span>
            </button>
          )}
          <button type="button" className={`jv-mode${s.enabled ? " is-on" : ""}`} role="switch" aria-checked={s.enabled}
            aria-label="Jarvis mode" data-testid="jarvis-mode-switch"
            title={s.enabled ? "Jarvis mode is on — “Hey Jarvis” works anywhere. Click to turn off." : "Turn on Jarvis mode to use “Hey Jarvis”"}
            onClick={() => {
              // Off means off: release the mic now, not just the wake word.
              if (s.enabled) stopListening();
              useJarvis.getState().setEnabled(!s.enabled);
            }}>
            <span className="jv-mode-track" aria-hidden="true"><span className="jv-mode-thumb" /></span><span>Jarvis mode</span>
            <span className="jv-mode-state" aria-hidden="true">{s.enabled ? "On" : "Off"}</span>
          </button>
          <button className="jv-close" aria-label="Close assistant (Esc)" title="Close assistant · Esc"
            onClick={() => useJarvis.getState().close()}><Icon name="x" /></button>
        </div>
      </header>
      <div className="jv-body">
        <section className="jv-stage" aria-label="Assistant activity">
          <Presence phase={s.phase} theme={theme} reduced={reduced} />
          <div className={`jv-status${s.error ? " is-error" : ""}`} role="status" data-testid="jarvis-status">
            <span className="jv-status-dot" aria-hidden="true" />{status}
          </div>
          {!hasConversation && !s.error && <>
            <h2 className="jv-greeting">{listening ? "Go ahead. I'm here." : "Let's pick up the thread."}</h2>
            <p className="jv-hint">Catch up, find an answer, or put a thought into words.</p>
          </>}
          {s.busy && !currentLog.some(e => e.role === "assistant" && e.text) && (
            <div className="jv-progress" aria-hidden="true"><span /><span /><span /></div>
          )}
        </section>
        <div className="jv-conversation">
          {history.length > 0 && <details className="jv-history" key={currentTurnId}>
            <summary><Icon name="messages-square" /> Earlier in this conversation <span>{history.filter(e => e.role === "user").length}</span><Icon name="chevron-down" /></summary>
            <div className="jv-history-log">{history.map(entry => <LogLine key={entry.id} entry={entry} spoken={null} streaming={false} />)}</div>
          </details>}
          <div className="jv-log" ref={logRef} role="log" aria-label="Current conversation" tabIndex={0}
            aria-live="polite" aria-busy={s.busy} data-testid="jarvis-log"
            onWheel={() => { followAnswer.current = false; }}
            onTouchMove={() => { followAnswer.current = false; }}
            onKeyDown={e => {
              if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home"].includes(e.key)) followAnswer.current = false;
              if (e.key === "End") followAnswer.current = true;
            }}
            onScroll={e => {
              const el = e.currentTarget;
              if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) followAnswer.current = true;
            }}>
            {currentLog.map(entry => (
              <LogLine key={entry.id} entry={entry}
                spoken={s.spoken?.id === entry.id ? s.spoken : null}
                streaming={s.busy && entry.id === lastId && entry.role === "assistant"} />
            ))}
          </div>
          {!hasConversation && !s.error && <div className="jv-suggestions" aria-label="Suggested questions">
            <button type="button" onClick={() => choosePrompt("Catch me up on my unread conversations")}><Icon name="sparkles" />Catch me up<Icon name="chevron-right" /></button>
            <button type="button" onClick={() => choosePrompt("What needs my attention?")}><Icon name="at-sign" />What needs me?<Icon name="chevron-right" /></button>
            <button type="button" onClick={() => choosePrompt("Help me draft a message to ")}><Icon name="pencil" />Draft a message<Icon name="chevron-right" /></button>
          </div>}
        </div>
        {s.cards.length > 0 && <section className="jv-results" aria-label="Conversation details">
          <div className="jv-section-label"><span>From your workspace</span>{primaryCards.length > 1 && <span>{primaryCards.length} results</span>}</div>
          <div className="jv-cards" aria-live="polite">
            {primaryCards.map(entry => <JarvisCardView key={entry.id} entry={entry} />)}
          </div>
          {earlierCards.length > 0 && <details className="jv-previous-results"><summary>Earlier results <span>{earlierCards.length}</span><Icon name="chevron-down" /></summary>
            <div className="jv-cards">{earlierCards.map(entry => <JarvisCardView key={entry.id} entry={entry} />)}</div>
          </details>}
        </section>}
      </div>
      <footer className="jv-footer">
        <div className="jv-controls">
          <div className="jv-voice-controls">
            <button type="button" className={`jv-toggle${!stt ? " is-unavailable" : s.micMuted ? " is-off" : listening ? " is-live" : ""}`}
              aria-label="Microphone" aria-pressed={stt && !s.micMuted} aria-disabled={!stt} title={micTitle}
              data-testid="jarvis-mic"
              onClick={() => { if (stt) useJarvis.getState().setMicMuted(!s.micMuted); }}>
              <Icon name={stt && !s.micMuted ? "mic" : "mic-off"} /><span>{!stt ? "Voice unavailable" : s.micMuted ? "Mic off" : "Mic on"}</span>
            </button>
            <button type="button" className={`jv-toggle${!tts ? " is-unavailable" : s.speakerOff ? " is-off" : s.phase === "speaking" ? " is-live" : ""}`}
              aria-label="Speaker" aria-pressed={tts && !s.speakerOff} aria-disabled={!tts} title={speakerTitle}
              data-testid="jarvis-speaker"
              onClick={() => { if (tts) useJarvis.getState().setSpeakerOff(!s.speakerOff); }}>
              <Icon name={tts && !s.speakerOff ? "volume-2" : "volume-x"} /><span>{!tts || s.speakerOff ? "Sound off" : "Sound on"}</span>
            </button>
          </div>
          <span className="jv-voice-hint">{voiceHint}</span>
        </div>
        <form className="jv-input" onSubmit={submit}>
          <input ref={inputRef} value={text} onChange={e => setText(e.target.value)} maxLength={4000}
            placeholder={s.busy ? "Working…" : listening ? "Or type…" : "Ask Agora…"} aria-label="Ask Agora" />
          <button className="jv-submit" type="submit" aria-label="Ask" title="Send message" disabled={s.busy || !text.trim()}><Icon name="arrow-up" /></button>
        </form>
      </footer>
    </div>
  );
  return (
    <div className="jv-dock">
      {reduced ? panel : (
        <VoiceBeam colorVariant="ocean" level={jarvisLevel.get} theme={theme} idle={s.busy || listening ? 0.2 : 0.04} className="jv-beam">
          {panel}
        </VoiceBeam>
      )}
    </div>
  );
}
