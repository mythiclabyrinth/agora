/* Card stack for the Agora assistant: digests, message hits, and drafts.
   Cards carry the detail so the spoken answer can stay short. */

import { useEffect, useState } from "react";
import { ApiError, cancelJarvisDraft, sendJarvisDraft, useApi, type ApiClient, type JarvisCard, type JarvisDigestItem, type JarvisMessageHit } from "@agora/core";
import { Icon } from "../../lib/icons";
import { toast } from "../../lib/toast";
import { useJump } from "../../state/jump";
import { useUiState } from "../../state/ui";
import { useJarvis, type JarvisCardEntry } from "../../state/jarvis";

const UNDO_MS = 5000;

export type JarvisDraftCard = Extract<JarvisCard, { kind: "draft" }>;

/** Navigate in-app to a channel, thread, or message. */
function jumpTo(target: { group_id: string; channel_id: string; thread_id?: number | null; message_id?: number }) {
  const ui = useUiState.getState();
  ui.selectChannel(target.group_id, target.channel_id);
  if (target.thread_id != null) {
    ui.openThread(target.thread_id, "replace");
    if (target.message_id != null) useJump.getState().request({ mid: target.message_id, container: "thread" });
  } else if (target.message_id != null) {
    useJump.getState().request({ mid: target.message_id, container: "log" });
  }
}

const where = (i: { channel_name: string; group_id: string }) => i.group_id === "__dms" ? i.channel_name : `#${i.channel_name}`;

function DigestRow({ item }: { item: JarvisDigestItem }) {
  return (
    <li className="jv-digest-row">
      <div className="jv-digest-head">
        <span className="jv-where">{where(item)}</span>
        {item.thread_id != null && <span className="jv-thread" title={item.thread_title || "Thread"}>› {item.thread_title || "thread"}</span>}
        {item.needs_you && <span className="jv-badge">Needs you</span>}
        {item.unread > 0 && <span className="jv-count">{item.unread} new</span>}
      </div>
      <p className="jv-gist">{item.gist}</p>
      <button className="jv-link" onClick={() => jumpTo(item)}>
        Open {item.thread_id != null ? "thread" : "channel"} →
      </button>
    </li>
  );
}

function MessageRow({ hit }: { hit: JarvisMessageHit }) {
  return (
    <li className="jv-msg-row">
      <button className="jv-msg" onClick={() => jumpTo({ ...hit, message_id: hit.id })}>
        <span className="jv-msg-meta"><b>{hit.author || "someone"}</b> in {where(hit)}</span>
        <span className="jv-msg-text">{hit.text}</span>
      </button>
    </li>
  );
}

function useCountdown(seconds: number): number {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, Math.round(seconds - (now - startedAt) / 1000));
}

/** Confirm a draft (the card's Send, or a spoken "send it"): the server
    posts it as the user, with a short Undo. Posts the card's text as it
    stands, edits included. Resolves true once sent. */
export async function sendDraftEntry(api: ApiClient, entry: JarvisCardEntry, card: JarvisDraftCard): Promise<boolean> {
  const { setCardStatus: setStatus } = useJarvis.getState();
  const text = useJarvis.getState().cards.find(c => c.id === entry.id)?.text ?? entry.text;
  if (text !== undefined && !text.trim()) {
    toast("The draft is empty — type a message or cancel it", { variant: "warn" });
    return false;
  }
  setStatus(entry.id, "sending");
  try {
    const res = await sendJarvisDraft(api, card.draft_id, text);
    setStatus(entry.id, "sent");
    const sentAt = Date.now();
    const mid = res.message.id;
    toast(`Sent to ${card.destination}`, {
      variant: "ok",
      actionLabel: "Undo",
      onAction: () => {
        if (Date.now() - sentAt > UNDO_MS) { toast("Too late to undo — delete it from the conversation", { variant: "warn" }); return; }
        void api.delete(`/api/channels/${encodeURIComponent(card.channel_id)}/messages/${mid}`)
          .then(() => { setStatus(entry.id, "cancelled"); toast("Unsent", { variant: "ok" }); })
          .catch(e => toast("Couldn't undo: " + (e as Error).message, { variant: "error" }));
      },
    });
    return true;
  } catch (e) {
    const gone = e instanceof ApiError && (e.status === 410 || e.status === 404);
    setStatus(entry.id, gone ? "expired" : "pending");
    toast("Couldn't send: " + (e as Error).message, { variant: "error" });
    return false;
  }
}

export function cancelDraftEntry(api: ApiClient, entry: JarvisCardEntry, card: JarvisDraftCard): void {
  useJarvis.getState().setCardStatus(entry.id, "cancelled");
  void cancelJarvisDraft(api, card.draft_id).catch(() => { /* expired drafts are already gone */ });
}

function DraftCard({ entry, card }: { entry: JarvisCardEntry; card: JarvisDraftCard }) {
  const api = useApi();
  const setStatus = useJarvis(s => s.setCardStatus);
  const setCardText = useJarvis(s => s.setCardText);
  const text = entry.text ?? card.text;
  const [editing, setEditing] = useState(false);
  const left = useCountdown(card.expires_in);
  const status = entry.status ?? "pending";
  const live = status === "pending" && left > 0;

  useEffect(() => {
    if (status === "pending" && left === 0) setStatus(entry.id, "expired");
  }, [left, status, entry.id, setStatus]);

  const send = () => sendDraftEntry(api, entry, card);
  const cancel = () => cancelDraftEntry(api, entry, card);

  return (
    <div className={`jv-card jv-draft is-${status}`} data-testid="jarvis-draft">
      <div className="jv-card-title">
        <Icon name="pencil" /> Draft to <span className="jv-where">{card.destination}</span>
        {live && <span className="jv-expiry" title="Drafts expire if not sent">{left}s</span>}
      </div>
      {card.thread_title && <div className="jv-thread-line">› {card.thread_title}</div>}
      {card.mentions.length > 0 && (
        <div className="jv-mentions">
          {card.mentions.map(m => <span key={m.id} className="jv-mention" title={m.kind === "agent" ? "Agent" : "Person"}>@{m.handle}</span>)}
        </div>
      )}
      <textarea className="jv-draft-text" value={text} readOnly={!editing || !live} rows={Math.min(6, Math.max(2, Math.ceil(text.length / 60)))}
        aria-label="Draft message" onChange={e => setCardText(entry.id, e.target.value)} />
      <div className="jv-draft-actions">
        {status === "sent" && <span className="jv-done"><Icon name="check" /> Sent</span>}
        {status === "cancelled" && <span className="jv-muted">Cancelled</span>}
        {status === "expired" && <span className="jv-muted">Expired — ask again to redraft</span>}
        {(status === "pending" || status === "sending") && <>
          <button className="btn sm primary" disabled={!live || !text.trim()} onClick={() => void send()}>
            {status === "sending" ? "Sending…" : "Send"}
          </button>
          <button className="btn sm" disabled={!live} onClick={() => setEditing(!editing)}>{editing ? "Done" : "Edit"}</button>
          <button className="btn sm" disabled={status === "sending"} onClick={cancel}>Cancel</button>
        </>}
      </div>
    </div>
  );
}

export function JarvisCardView({ entry }: { entry: JarvisCardEntry }) {
  const dismiss = useJarvis(s => s.dismissCard);
  const { card } = entry;
  const close = <button className="jv-dismiss" aria-label="Dismiss card" onClick={() => dismiss(entry.id)}><Icon name="x" /></button>;
  if (card.kind === "draft") return <div className="jv-card-wrap">{close}<DraftCard entry={entry} card={card} /></div>;
  if (card.kind === "digest") {
    return (
      <div className="jv-card-wrap">{close}
        <div className="jv-card jv-digest" data-testid="jarvis-digest">
          <div className="jv-card-title"><Icon name="sparkles" /> Digest</div>
          <ul>{card.items.map(i => <DigestRow key={`${i.channel_id}:${i.thread_id ?? ""}`} item={i} />)}</ul>
        </div>
      </div>
    );
  }
  return (
    <div className="jv-card-wrap">{close}
      <div className="jv-card jv-messages">
        <div className="jv-card-title"><Icon name="search" /> {card.title}</div>
        <ul>{card.messages.slice(0, 6).map(m => <MessageRow key={m.id} hit={m} />)}</ul>
      </div>
    </div>
  );
}
