/* Card stack for the Agora assistant: digests, message hits, and drafts.
   Cards carry the detail so the spoken answer can stay short. */

import { useEffect, useId, useRef, useState } from "react";
import {
  ApiError, cancelJarvisDraft, sendJarvisDraft, updateJarvisDraft, useApi,
  type ApiClient, type JarvisCard, type JarvisDigestItem, type JarvisMessageHit,
} from "@agora/core";
import { Icon } from "../../lib/icons";
import { toast } from "../../lib/toast";
import { useJump } from "../../state/jump";
import { useUiState } from "../../state/ui";
import { isLiveDraft, useJarvis, type JarvisCardEntry } from "../../state/jarvis";

const UNDO_MS = 5000;
/** Typing pauses this long before an edit is saved (blur and Send save at once). */
export const SAVE_DEBOUNCE_MS = 700;

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
  const gistId = useId();
  return (
    <li className={`jv-digest-row${item.needs_you ? " needs-you" : ""}`}>
      <button className="jv-digest-target" onClick={() => jumpTo(item)}
        aria-describedby={gistId}
        aria-label={`Open ${item.thread_id != null ? "thread" : "channel"}: ${where(item)}${item.thread_title ? `, ${item.thread_title}` : ""}${item.needs_you ? ", needs your attention" : ""}`}>
        <span className="jv-source">{item.group_name}</span>
        <span className="jv-digest-head">
          <span className="jv-where">{where(item)}</span>
          {item.needs_you && <span className="jv-badge">Needs you</span>}
          {item.unread > 0 && <span className="jv-count">{item.unread} new</span>}
        </span>
        {item.thread_id != null && <span className="jv-thread" title={item.thread_title || "Thread"}>{item.thread_title || "Thread"}</span>}
        <span className="jv-gist" id={gistId}>{item.gist}</span>
        <span className="jv-row-arrow" aria-hidden="true"><Icon name="chevron-right" /></span>
      </button>
    </li>
  );
}

function MessageRow({ hit }: { hit: JarvisMessageHit }) {
  return (
    <li className="jv-msg-row">
      <button className="jv-msg" onClick={() => jumpTo({ ...hit, message_id: hit.id })}>
        <span className="jv-msg-meta"><b>{hit.author || "someone"}</b><span className="jv-where">{hit.group_name} / {where(hit)}</span></span>
        <span className="jv-msg-text">{hit.text}</span>
        <span className="jv-msg-open">Open message <Icon name="chevron-right" /></span>
      </button>
    </li>
  );
}

/** Seconds left until `expiresAt` (ms since epoch). */
function useCountdown(expiresAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, Math.round((expiresAt - now) / 1000));
}

const cardById = (id: string) => useJarvis.getState().cards.find(c => c.id === id);

/** A draft call failed: a gone draft shows as expired; the reason is toasted. */
function draftFailed(entryId: string, e: unknown, prefix: string): void {
  const status = e instanceof ApiError ? e.status : 0;
  const now = cardById(entryId)?.status;
  if (status === 410 || status === 404) useJarvis.getState().setCardStatus(entryId, "expired");
  else if (now === "sending") useJarvis.getState().setCardStatus(entryId, "pending");
  toast(prefix + ((e as Error).message || "request failed"), { variant: status === 409 ? "warn" : "error" });
}

/** A save the server refused as stale (409): the draft changed or was sent
    elsewhere, so this card can't catch up. It is closed — never retried,
    never approvable — and a fresh draft is the way on. */
function draftConflict(api: ApiClient, entryId: string, draftId: string, e: unknown): void {
  useJarvis.getState().setCardStatus(entryId, "cancelled");
  void cancelJarvisDraft(api, draftId).catch(() => { /* already gone */ });
  toast(`${(e as Error).message || "This draft changed elsewhere"}. Ask for a fresh draft.`, { variant: "warn" });
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const saving = new Map<string, Promise<boolean>>();

/** Save a draft card's edit to the server when it differs from what the
    server has, so Send — and a spoken yes, which the server judges against
    its own copy — post exactly what the card shows. One save per card at a
    time (each needs the previous revision). Resolves false when the edit
    could not be saved (or is empty). */
export function saveDraftEdit(api: ApiClient, entryId: string): Promise<boolean> {
  const timer = saveTimers.get(entryId);
  if (timer) {
    clearTimeout(timer);
    saveTimers.delete(entryId);
  }
  const next = (saving.get(entryId) ?? Promise.resolve(true)).then(async () => {
    const entry = cardById(entryId);
    if (!entry || entry.card.kind !== "draft" || entry.text === undefined) return true;
    const text = entry.text.trim();
    if (text === (entry.savedText ?? entry.card.text).trim()) return true;
    if (!text) return false;
    try {
      const saved = await updateJarvisDraft(api, entry.card.draft_id, text, entry.revision ?? entry.card.revision ?? 1);
      useJarvis.getState().setCardSaved(entryId, saved.text, saved.revision);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) draftConflict(api, entryId, entry.card.draft_id, e);
      else draftFailed(entryId, e, "Couldn't save the edit: ");
      return false;
    }
  });
  saving.set(entryId, next);
  void next.finally(() => { if (saving.get(entryId) === next) saving.delete(entryId); });
  return next;
}

/** Save an edit once typing pauses. */
export function scheduleDraftSave(api: ApiClient, entryId: string): void {
  const timer = saveTimers.get(entryId);
  if (timer) clearTimeout(timer);
  saveTimers.set(entryId, setTimeout(() => { saveTimers.delete(entryId); void saveDraftEdit(api, entryId); }, SAVE_DEBOUNCE_MS));
}

/** A draft was posted (by Send or by an approved reply): the toast with a
    short Undo, which deletes the message through the normal delete API. */
export function announceSent(api: ApiClient, entryId: string, card: JarvisDraftCard, messageId: number): void {
  const sentAt = Date.now();
  toast(`Sent to ${card.destination}`, {
    variant: "ok",
    actionLabel: "Undo",
    onAction: () => {
      if (Date.now() - sentAt > UNDO_MS) { toast("Too late to undo — delete it from the conversation", { variant: "warn" }); return; }
      void api.delete(`/api/channels/${encodeURIComponent(card.channel_id)}/messages/${messageId}`)
        .then(() => { useJarvis.getState().setCardStatus(entryId, "cancelled"); toast("Unsent", { variant: "ok" }); })
        .catch(e => toast("Couldn't undo: " + (e as Error).message, { variant: "error" }));
    },
  });
}

/** Confirm a draft with the card's Send: saves any pending edit first, then
    sends at the revision the card shows (the server refuses a stale one).
    Resolves true once sent. */
export async function sendDraftEntry(api: ApiClient, entry: JarvisCardEntry, card: JarvisDraftCard): Promise<boolean> {
  const { setCardStatus: setStatus } = useJarvis.getState();
  const text = cardById(entry.id)?.text ?? entry.text;
  if (text !== undefined && !text.trim()) {
    toast("The draft is empty — type a message or cancel it", { variant: "warn" });
    return false;
  }
  setStatus(entry.id, "sending");
  if (!(await saveDraftEdit(api, entry.id))) {
    if (cardById(entry.id)?.status === "sending") setStatus(entry.id, "pending");
    return false;
  }
  try {
    const revision = cardById(entry.id)?.revision ?? card.revision ?? 1;
    const res = await sendJarvisDraft(api, card.draft_id, revision);
    useJarvis.setState(s => ({
      cards: s.cards.map(c => c.id === entry.id ? { ...c, status: "sent" as const, messageId: res.message.id } : c),
    }));
    // Already posted (a spoken yes won the race): its toast was shown then.
    if (!res.already_sent) announceSent(api, entry.id, card, res.message.id);
    return true;
  } catch (e) {
    draftFailed(entry.id, e, "Couldn't send: ");
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
  const editor = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const hintId = useId();
  const [fallbackExpiry] = useState(() => Date.now() + card.expires_in * 1000);
  const left = useCountdown(entry.expiresAt ?? fallbackExpiry);
  const status = entry.status ?? "pending";
  const live = isLiveDraft({ ...entry, expiresAt: entry.expiresAt ?? fallbackExpiry }) && left > 0;

  useEffect(() => {
    if (status === "pending" && left === 0) setStatus(entry.id, "expired");
  }, [left, status, entry.id, setStatus]);

  const send = () => sendDraftEntry(api, entry, card);
  const statusLabel = status === "sent" ? "Sent" : status === "sending" ? "Sending…" : status === "cancelled" ? "Closed" : status === "expired" ? "Expired" : "Awaiting your confirmation";

  return (
    <div className={`jv-card jv-draft is-${status}`} data-testid="jarvis-draft" role="group" aria-labelledby={titleId}>
      <div className="jv-card-heading">
        <span className="jv-card-symbol"><Icon name={status === "sent" ? "check" : "pencil"} /></span>
        <div className="jv-card-heading-copy">
          <span className="jv-card-kicker">Message draft · {card.group_name}</span>
          <h3 id={titleId}>To <span className="jv-where">{card.destination}</span></h3>
        </div>
      </div>
      {card.thread_title && <div className="jv-thread-line"><Icon name="corner-down-right" />{card.thread_title}</div>}
      <div className="jv-draft-state">
        <span className={status === "sent" ? "jv-done" : "jv-draft-status"}>{statusLabel}</span>
        {live && <span className={`jv-expiry${left <= 20 ? " is-soon" : ""}`} aria-live="off" title="This draft expires automatically if you do not send it">Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</span>}
      </div>
      {card.mentions.length > 0 && (
        <div className="jv-mentions" aria-label="Tagged recipients">
          <span className="jv-recipient-label">Tagging</span>
          {card.mentions.map(m => <span key={m.id} className="jv-mention" title={m.kind === "agent" ? "Agent" : "Person"}>@{m.handle}</span>)}
        </div>
      )}
      <textarea ref={editor} className="jv-draft-text" value={text} maxLength={20000} readOnly={!editing || !live} rows={Math.min(6, Math.max(2, Math.ceil(text.length / 60)))}
        aria-label="Draft message" aria-describedby={hintId} aria-live="off"
        onChange={e => { setCardText(entry.id, e.target.value); scheduleDraftSave(api, entry.id); }}
        onBlur={() => { if (editing) void saveDraftEdit(api, entry.id); }} />
      <p className="jv-confirm-hint" id={hintId}>
        <Icon name={status === "sent" ? "check" : "lock"} />
        {status === "sent" ? "Posted to the conversation. Undo is offered in the send notification." : status === "sending" ? "Posting your confirmed message…" : status === "cancelled" ? "This draft is closed. It cannot be sent again." : status === "expired" ? "Nothing was sent. Ask Agora for a fresh draft." : "Only sent after you confirm."}
      </p>
      <div className="jv-draft-actions">
        {(status === "pending" || status === "sending") && <>
          <button className="btn sm primary" disabled={!live || !text.trim()} onClick={() => void send()}>
            <Icon name="arrow-up" />{status === "sending" ? "Sending…" : "Send"}
          </button>
          <button className="btn sm" disabled={!live} aria-pressed={editing} onClick={() => {
            setEditing(!editing);
            if (!editing) editor.current?.focus();
            else void saveDraftEdit(api, entry.id);
          }}>{editing ? "Done" : "Edit"}</button>
          <button className="jv-discard" disabled={!live} onClick={e => {
            const panel = e.currentTarget.closest(".jv-panel");
            dismissCardEntry(api, entry);
            panel?.querySelector<HTMLInputElement>('[aria-label="Ask Agora"]')?.focus();
          }}><Icon name="trash-2" />Discard draft</button>
        </>}
        {status === "sent" && <button className="btn sm" onClick={() => jumpTo(card)}>Open conversation <Icon name="chevron-right" /></button>}
      </div>
    </div>
  );
}

function DigestCard({ items }: { items: JarvisDigestItem[] }) {
  const [onlyNeedsYou, setOnlyNeedsYou] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const titleId = useId();
  const listId = useId();
  const needed = items.filter(item => item.needs_you).length;
  const ordered = [...items].sort((a, b) => Number(b.needs_you) - Number(a.needs_you));
  const filtered = onlyNeedsYou ? ordered.filter(item => item.needs_you) : ordered;
  const visible = expanded ? filtered : filtered.slice(0, 2);
  return <div className="jv-card jv-digest" data-testid="jarvis-digest" role="group" aria-labelledby={titleId}>
    <div className="jv-card-heading">
      <span className="jv-card-symbol"><Icon name="sparkles" /></span>
      <div className="jv-card-heading-copy"><span className="jv-card-kicker">At a glance · {items.length} {items.length === 1 ? "conversation" : "conversations"}</span><h3 id={titleId}>Your briefing</h3></div>
    </div>
    {needed > 0 && <div className="jv-filters" aria-label="Filter briefing">
      <button type="button" aria-pressed={!onlyNeedsYou} onClick={() => { setOnlyNeedsYou(false); setExpanded(false); }}>All activity</button>
      <button type="button" aria-pressed={onlyNeedsYou} onClick={() => { setOnlyNeedsYou(true); setExpanded(false); }}>Needs you <span>{needed}</span></button>
    </div>}
    {items.length === 0 && <p className="jv-card-empty">No conversations in this briefing.</p>}
    <ul id={listId}>{visible.map(item => <DigestRow key={`${item.channel_id}:${item.thread_id ?? ""}`} item={item} />)}</ul>
    {filtered.length > 2 && <button type="button" className="jv-show-more" aria-controls={listId} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      {expanded ? "Show less" : `Show ${filtered.length - 2} more conversations`}<Icon name={expanded ? "chevron-up" : "chevron-down"} />
    </button>}
  </div>;
}

/** Discard/hide a card. A draft still awaiting the user is discarded on the server
    too, not just hidden: otherwise it stays sendable for its TTL, holds a
    draft slot, and a later bare "yes" could confirm a draft that is no longer
    on screen. A draft mid-send is only hidden; its send finishes. */
export function dismissCardEntry(api: ApiClient, entry: JarvisCardEntry): void {
  if (entry.card.kind === "draft" && (entry.status ?? "pending") === "pending") {
    const timer = saveTimers.get(entry.id);
    if (timer) clearTimeout(timer);
    saveTimers.delete(entry.id);
    cancelDraftEntry(api, entry, entry.card);
  }
  useJarvis.getState().dismissCard(entry.id);
}

export function JarvisCardView({ entry }: { entry: JarvisCardEntry }) {
  const api = useApi();
  const { card } = entry;
  const discards = isLiveDraft(entry);
  const close = !discards && <button className="jv-dismiss" aria-label="Dismiss card"
    title="Hide this card" onClick={e => {
      const panel = e.currentTarget.closest(".jv-panel");
      dismissCardEntry(api, entry);
      panel?.querySelector<HTMLInputElement>('[aria-label="Ask Agora"]')?.focus();
    }}><Icon name="x" /></button>;
  if (card.kind === "draft") return <div className="jv-card-wrap">{close}<DraftCard entry={entry} card={card} /></div>;
  if (card.kind === "digest") {
    return (
      <div className="jv-card-wrap">{close}
        <DigestCard items={card.items} />
      </div>
    );
  }
  return (
    <div className="jv-card-wrap">{close}
      <div className="jv-card jv-messages">
        <div className="jv-card-heading">
          <span className="jv-card-symbol"><Icon name="search" /></span>
          <div className="jv-card-heading-copy"><span className="jv-card-kicker">Message matches · {card.messages.length > 6 ? `6 of ${card.messages.length}` : card.messages.length}</span><h3>{card.title}</h3></div>
        </div>
        {card.messages.length === 0 && <p className="jv-card-empty">No matching messages. Try another phrase or channel.</p>}
        <ul>{card.messages.slice(0, 6).map(m => <MessageRow key={m.id} hit={m} />)}</ul>
      </div>
    </div>
  );
}
