/* The reply pop-up under the Jarvis mode chip: with Jarvis mode on and the
   panel closed, Jarvis's latest reply shows here while it streams and
   speaks (a background "Hey Jarvis", or an answer that outlived the panel).
   Three lines collapsed; a click expands it, and it follows the sentence
   being spoken. It never takes focus, and fades a few seconds after the
   answer is done unless hovered or expanded. Only Jarvis's own replies. */

import { useEffect, useRef, useState } from "react";
import { isDraftLikeCard, useApi, useMe } from "@agora/core";
import { Icon } from "../../lib/icons";
import { isLiveDraft, useJarvis } from "../../state/jarvis";
import { listenInBackground, stopListening, stopSpeaking } from "../voice/conversation";
import { cancelDraftEntry, sendDraftEntry } from "./JarvisCards";
import { splitTurn } from "./derive";

/** How long the pop-up stays once the answer is done. */
export const POPUP_LINGER_MS = 8_000;

export function JarvisReplyPopup() {
  const me = useMe().data;
  const api = useApi();
  const enabled = useJarvis(s => s.enabled);
  const isOpen = useJarvis(s => s.isOpen);
  const busy = useJarvis(s => s.busy);
  const audioActive = useJarvis(s => s.audioActive);
  const phase = useJarvis(s => s.phase);
  const log = useJarvis(s => s.log);
  const spoken = useJarvis(s => s.spoken);
  const cards = useJarvis(s => s.cards);
  const micMuted = useJarvis(s => s.micMuted);
  const error = useJarvis(s => s.error);
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [lingerUntil, setLingerUntil] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [, tick] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  const { current } = splitTurn(log);
  const question = current.find(e => e.role === "user");
  const reply = [...current].reverse().find(e => e.role === "assistant");
  const turnId = question?.id ?? reply?.id ?? null;
  const hearing = phase === "listening" || phase === "recording" || phase === "transcribing";
  const answering = busy || audioActive;
  const active = answering || hearing;

  // Linger after the answer is done; a new turn starts fresh (collapsed,
  // following, not dismissed).
  const wasAnswering = useRef(answering);
  useEffect(() => {
    // Only for an answer that ended with the panel closed (one that ended in
    // the open panel was seen there), never for a listen that heard nothing.
    if (wasAnswering.current && !answering && !useJarvis.getState().isOpen) setLingerUntil(Date.now() + POPUP_LINGER_MS);
    wasAnswering.current = answering;
  }, [answering]);
  useEffect(() => { setExpanded(false); setHovered(false); follow.current = true; }, [turnId]);
  useEffect(() => {
    if (!lingerUntil) return;
    const t = setTimeout(() => tick(n => n + 1), Math.max(0, lingerUntil - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [lingerUntil]);
  // Follow the sentence being spoken, unless the user scrolled.
  useEffect(() => {
    const body = bodyRef.current;
    const mark = body?.querySelector(".jv-spoken");
    if (!body || !mark || !follow.current) return;
    const line = mark.getBoundingClientRect();
    const view = body.getBoundingClientRect();
    if (line.top < view.top) body.scrollTop += line.top - view.top;
    else if (line.bottom > view.bottom) body.scrollTop += line.bottom - view.bottom;
  }, [spoken, expanded]);

  // While a new request is being heard, the last exchange isn't shown as
  // if it were being asked again: just "Listening…".
  const listeningAnew = hearing && !busy;
  const visible = me?.jarvis === true && enabled && !isOpen
    && (listeningAnew || (turnId !== null && dismissed !== turnId && (active || hovered || focused || expanded || Date.now() < lingerUntil)));
  // While it listens in the background, the pop-up is where you can stop it.
  const stopHearing = () => {
    stopListening();
    const st = useJarvis.getState();
    if (st.phase === "listening" || st.phase === "recording") st.setVoicePhase(null);
    setHovered(false); setFocused(false);
  };
  // Unmounting under the pointer (or focus) never fires leave/blur.
  useEffect(() => { if (!visible) { setHovered(false); setFocused(false); } }, [visible]);
  if (!visible) return null;

  const text = reply?.text ?? "";
  const body = spoken && reply && spoken.id === reply.id && spoken.end <= text.length
    ? <>{text.slice(0, spoken.start)}<mark className="jv-spoken">{text.slice(spoken.start, spoken.end)}</mark>{text.slice(spoken.end)}</>
    : text;
  const draft = cards.find(c => isLiveDraft(c));
  const stt = me?.jarvis_stt === true;
  const status = listeningAnew ? "Listening…" : busy && !text ? "Thinking…" : null;
  const openPanel = () => { setDismissed(turnId); setHovered(false); useJarvis.getState().open(); };
  // A short status for screen readers; the streaming text itself isn't a
  // live region (it would be re-read on every word while it's spoken).
  const announce = status ?? (error && !answering ? error : answering ? "Jarvis is replying" : "Jarvis replied");

  return (
    <div className={`jv-popup${expanded ? " is-expanded" : ""}`} role="region" aria-label="Jarvis reply"
      data-testid="jarvis-popup" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false); }}>
      <span className="sr-only" role="status" aria-live="polite">{announce}</span>
      {!listeningAnew && question && <div className="jv-popup-asked"><Icon name="mic" /><span>{question.text}</span></div>}
      {status && <div className="jv-popup-status"><span className="jv-status-dot" aria-hidden="true" />{status}</div>}
      {!listeningAnew && error && !answering && <div className="jv-popup-error" role="alert">{error}</div>}
      {!listeningAnew && text && (
        <div ref={bodyRef} className="jv-popup-body" id="jv-popup-body"
          title={expanded ? "Click to collapse" : "Click to read more"}
          onMouseDown={e => e.preventDefault() /* never take focus from what you're typing */}
          onClick={() => setExpanded(!expanded)}
          onWheel={() => { follow.current = false; }} onTouchMove={() => { follow.current = false; }}>
          {body}
        </div>
      )}
      {!listeningAnew && draft && isDraftLikeCard(draft.card) && (
        <div className="jv-popup-draft" data-testid="jarvis-popup-draft">
          {draft.card.kind === "draft"
            ? <span className="jv-popup-draft-text"><b>{draft.card.destination}</b> {draft.text ?? draft.card.text}</span>
            : <span className="jv-popup-draft-text">A schedule change is waiting for you</span>}
          {draft.card.kind === "draft" && <button type="button" className="btn sm primary"
            onMouseDown={e => e.preventDefault()}
            onClick={() => { const c = draft.card; if (isDraftLikeCard(c)) void sendDraftEntry(api, draft, c); }}>Send</button>}
          <button type="button" className="btn sm" onMouseDown={e => e.preventDefault()} onClick={openPanel}>
            {draft.card.kind === "draft" ? "Edit" : "Review"}
          </button>
          {draft.card.kind === "draft" && <button type="button" className="btn sm" onMouseDown={e => e.preventDefault()}
            onClick={() => { const c = draft.card; if (isDraftLikeCard(c)) cancelDraftEntry(api, draft, c); }}>Cancel</button>}
        </div>
      )}
      <div className="jv-popup-actions">
        {text && <button type="button" className="jv-popup-icon" aria-expanded={expanded} aria-controls="jv-popup-body"
          aria-label={expanded ? "Show less" : "Show more"} title={expanded ? "Show less" : "Show more"}
          onMouseDown={e => e.preventDefault()} onClick={() => setExpanded(!expanded)}>
          <Icon name={expanded ? "chevron-up" : "chevron-down"} /></button>}
        {listeningAnew && <button type="button" className="jv-popup-icon" aria-label="Stop listening" title="Stop listening"
          onMouseDown={e => e.preventDefault()} onClick={stopHearing}><Icon name="mic-off" /></button>}
        {(busy || audioActive) && <button type="button" className="jv-popup-icon" aria-label="Stop speaking" title="Stop speaking — the text keeps coming"
          onMouseDown={e => e.preventDefault()} onClick={() => stopSpeaking()}><Icon name="square" /></button>}
        {!active && stt && !micMuted && <button type="button" className="jv-popup-icon" aria-label="Reply" title="Reply — speak your follow-up"
          onMouseDown={e => e.preventDefault()}
          onClick={() => { void listenInBackground(); }}><Icon name="mic" /></button>}
        <button type="button" className="jv-popup-icon" aria-label="Open the assistant" title="Open the assistant"
          onMouseDown={e => e.preventDefault()} onClick={openPanel}><Icon name="external-link" /></button>
        <button type="button" className="jv-popup-icon" aria-label="Dismiss" title="Dismiss"
          // Dismissing a reply that's still talking stops it too: with the
          // pop-up gone there'd be no Stop left short of opening the panel.
          onMouseDown={e => e.preventDefault()} onClick={() => {
            if (listeningAnew) { stopHearing(); return; }
            if (answering) stopSpeaking();
            setDismissed(turnId); setHovered(false);
          }}><Icon name="x" /></button>
      </div>
    </div>
  );
}
