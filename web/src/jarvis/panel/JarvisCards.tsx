/* Card stack for the Agora assistant: digests, message hits, drafts, and
   schedules (new ones, changes to the user's own, and their list).
   Cards carry the detail so the spoken answer can stay short. */

import { useEffect, useId, useRef, useState } from "react";
import {
  ApiError, cancelJarvisDraft, describeSchedule, formatLocal, formatUtc, isDraftLikeCard, sendJarvisDraft,
  updateJarvisDraft, useApi,
  type ApiClient, type JarvisCard, type JarvisDigestItem, type JarvisDraftLikeCard, type JarvisMessageHit,
  type JarvisScheduleChangeCard, type JarvisScheduleDraftCard, type JarvisSchedulesCard, type Schedule,
} from "@agora/core";
import { Icon } from "../../lib/icons";
import { toast } from "../../lib/toast";
import { jumpTo, type JarvisTarget } from "../navigate";
import { isLiveDraft, useJarvis, type JarvisCardEntry } from "../../state/jarvis";

const UNDO_MS = 5000;
/** Typing pauses this long before an edit is saved (blur and Send save at once). */
export const SAVE_DEBOUNCE_MS = 700;

export type JarvisDraftCard = Extract<JarvisCard, { kind: "draft" }>;

/** A card's "Open" buttons: go there and get the panel out of the way
    (Jarvis mode stays on; the wake word brings the panel back). */
export function openFromCard(target: JarvisTarget): void {
  jumpTo(target);
  useJarvis.getState().close();
}

const where = (i: { channel_name: string; group_id: string }) => i.group_id === "__dms" ? i.channel_name : `#${i.channel_name}`;

function DigestRow({ item }: { item: JarvisDigestItem }) {
  const gistId = useId();
  return (
    <li className={`jv-digest-row${item.needs_you ? " needs-you" : ""}`}>
      <button className="jv-digest-target" onClick={() => openFromCard(item)}
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
      <button className="jv-msg" onClick={() => openFromCard({ ...hit, message_id: hit.id })}>
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
  // A reply already posted it: the card says so, and stays that way.
  if (now === "sent") return;
  if (status === 410 || status === 404) useJarvis.getState().setCardStatus(entryId, "expired");
  else if (now === "sending") useJarvis.getState().setCardStatus(entryId, "pending");
  toast(prefix + ((e as Error).message || "request failed"), { variant: status === 409 ? "warn" : "error" });
}

/** A save or send the server refused as stale (409): the draft changed or
    was sent elsewhere, so this card can't catch up. It is closed — never retried,
    never approvable — and a fresh draft is the way on. */
function draftConflict(api: ApiClient, entryId: string, draftId: string, e: unknown): void {
  // "Already sent" is a 409 too: a spoken yes posted it while this save
  // was in flight. Its draft_sent event marks the card; nothing to close.
  if (cardById(entryId)?.status === "sent" || /already sent/i.test((e as Error).message)) return;
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
    if (!entry || (entry.card.kind !== "draft" && entry.card.kind !== "schedule_draft") || entry.text === undefined) return true;
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
export async function sendDraftEntry(api: ApiClient, entry: JarvisCardEntry, card: JarvisDraftLikeCard): Promise<boolean> {
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
    if (res.kind === "refreshed") {
      // The schedule changed after the user reviewed this: nothing was
      // written. The fresh card (against its current state) replaces this one.
      setStatus(entry.id, "cancelled");
      res.events.forEach(ev => useJarvis.getState().applyEvent(ev));
      toast(res.detail, { variant: "warn" });
      return false;
    }
    if (res.kind === "schedule") {
      useJarvis.setState(s => ({
        cards: s.cards.map(c => c.id === entry.id ? { ...c, status: "sent" as const, schedule: res.schedule } : c),
      }));
      if (!res.already_sent) announceScheduled(card, res.action);
      return true;
    }
    useJarvis.setState(s => ({
      cards: s.cards.map(c => c.id === entry.id ? { ...c, status: "sent" as const, messageId: res.message.id } : c),
    }));
    // Already posted (a spoken yes won the race): its toast was shown then.
    if (!res.already_sent && card.kind === "draft") announceSent(api, entry.id, card, res.message.id);
    return true;
  } catch (e) {
    // A stale revision can't be retried into success (the card has no newer
    // one): close it like a stale save, rather than leave a dead Send.
    if (e instanceof ApiError && e.status === 409) draftConflict(api, entry.id, card.draft_id, e);
    else draftFailed(entry.id, e, "Couldn't send: ");
    return false;
  }
}

/** A schedule draft was confirmed (by its button or a spoken yes). */
export function announceScheduled(card: JarvisDraftLikeCard, action: string): void {
  const done: Record<string, string> = {
    create: `Scheduled for ${card.destination}`, pause: "Schedule paused", resume: "Schedule resumed",
    cancel: "Schedule cancelled", retime: "Schedule time changed",
  };
  toast(done[action] ?? "Schedule updated", { variant: "ok" });
}

export function cancelDraftEntry(api: ApiClient, entry: JarvisCardEntry, card: JarvisDraftLikeCard): void {
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
        {status === "sent" && <button className="btn sm" onClick={() => openFromCard(card)}>Open conversation <Icon name="chevron-right" /></button>}
      </div>
    </div>
  );
}

/** The coming runs, in the user's own time (what they asked for), with UTC
    alongside: the server keeps schedules in UTC. */
function RunTimes({ runs, label = "Next runs" }: { runs: number[]; label?: string }) {
  if (!runs.length) return null;
  return (
    <div className="jv-sched-runs">
      <span className="jv-recipient-label">{label}</span>
      <ol>{runs.slice(0, 3).map(t => <li key={t}><span>{formatLocal(t)}</span><span className="jv-sched-utc">{formatUtc(t)}</span></li>)}</ol>
    </div>
  );
}

function DstNote({ note }: { note: string | null | undefined }) {
  return note ? <p className="jv-sched-dst" role="note"><Icon name="clock" />{note}</p> : null;
}

/** Countdown, expiry, and a lifecycle label shared by the confirmable schedule cards. */
function useDraftLifecycle(entry: JarvisCardEntry, expiresIn: number) {
  const setStatus = useJarvis(s => s.setCardStatus);
  const [fallbackExpiry] = useState(() => Date.now() + expiresIn * 1000);
  const left = useCountdown(entry.expiresAt ?? fallbackExpiry);
  const status = entry.status ?? "pending";
  const live = isLiveDraft({ ...entry, expiresAt: entry.expiresAt ?? fallbackExpiry }) && left > 0;
  useEffect(() => {
    if (status === "pending" && left === 0) setStatus(entry.id, "expired");
  }, [left, status, entry.id, setStatus]);
  return { left, status, live };
}

function Expiry({ left }: { left: number }) {
  return <span className={`jv-expiry${left <= 20 ? " is-soon" : ""}`} aria-live="off" title="This draft expires automatically if you do not confirm it">Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</span>;
}

function ScheduleDraftCard({ entry, card }: { entry: JarvisCardEntry; card: JarvisScheduleDraftCard }) {
  const api = useApi();
  const setCardText = useJarvis(s => s.setCardText);
  const text = entry.text ?? card.text;
  const [editing, setEditing] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const hintId = useId();
  const { left, status, live } = useDraftLifecycle(entry, card.expires_in);
  const statusLabel = status === "sent" ? "Scheduled" : status === "sending" ? "Scheduling…" : status === "cancelled" ? "Closed" : status === "expired" ? "Expired" : "Awaiting your confirmation";
  const runs = entry.schedule?.next_runs ?? card.next_runs;
  return (
    <div className={`jv-card jv-draft jv-sched-draft is-${status}`} data-testid="jarvis-schedule-draft" role="group" aria-labelledby={titleId}>
      <div className="jv-card-heading">
        <span className="jv-card-symbol"><Icon name={status === "sent" ? "check" : "calendar-clock"} /></span>
        <div className="jv-card-heading-copy">
          <span className="jv-card-kicker">Scheduled message · {card.group_name}</span>
          <h3 id={titleId}>To <span className="jv-where">{card.destination}</span></h3>
        </div>
      </div>
      <p className="jv-sched-when"><Icon name="clock" />{describeSchedule(card.schedule)}</p>
      <RunTimes runs={runs} label={card.schedule.kind === "once" ? "Posts at" : "Next runs"} />
      <DstNote note={card.dst_note} />
      <DstNote note={card.time_note} />
      <div className="jv-draft-state">
        <span className={status === "sent" ? "jv-done" : "jv-draft-status"}>{statusLabel}</span>
        {live && <Expiry left={left} />}
      </div>
      {card.mentions.length > 0 && (
        <div className="jv-mentions" aria-label="Tagged recipients">
          <span className="jv-recipient-label">Tagging</span>
          {card.mentions.map(m => <span key={m.id} className="jv-mention" title={m.kind === "agent" ? "Agent" : "Person"}>@{m.handle}</span>)}
        </div>
      )}
      <textarea ref={editor} className="jv-draft-text" value={text} maxLength={20000} readOnly={!editing || !live} rows={Math.min(6, Math.max(2, Math.ceil(text.length / 60)))}
        aria-label="Scheduled message" aria-describedby={hintId} aria-live="off"
        onChange={e => { setCardText(entry.id, e.target.value); scheduleDraftSave(api, entry.id); }}
        onBlur={() => { if (editing) void saveDraftEdit(api, entry.id); }} />
      <p className="jv-confirm-hint" id={hintId}>
        <Icon name={status === "sent" ? "check" : "lock"} />
        {status === "sent" ? "Scheduled. Manage it any time from Schedules." : status === "sending" ? "Creating your schedule…" : status === "cancelled" ? "This draft is closed. Nothing was scheduled." : status === "expired" ? "Nothing was scheduled. Ask Agora for a fresh draft." : "Only scheduled after you confirm. It posts as you."}
      </p>
      <div className="jv-draft-actions">
        {(status === "pending" || status === "sending") && <>
          <button className="btn sm primary" disabled={!live || !text.trim()} onClick={() => void sendDraftEntry(api, entry, card)}>
            <Icon name="calendar-clock" />{status === "sending" ? "Scheduling…" : "Schedule"}
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
          }}><Icon name="trash-2" />Discard</button>
        </>}
      </div>
    </div>
  );
}

const CHANGE_VERB: Record<JarvisScheduleChangeCard["action"], { label: string; icon: string; done: string }> = {
  pause: { label: "Pause", icon: "pause", done: "Paused" },
  resume: { label: "Resume", icon: "play", done: "Resumed" },
  cancel: { label: "Cancel schedule", icon: "x", done: "Cancelled" },
  retime: { label: "Change time", icon: "clock", done: "Time changed" },
};

function ScheduleChangeCard({ entry, card }: { entry: JarvisCardEntry; card: JarvisScheduleChangeCard }) {
  const api = useApi();
  const titleId = useId();
  const { left, status, live } = useDraftLifecycle(entry, card.expires_in);
  const verb = CHANGE_VERB[card.action];
  const before = card.schedule;
  const statusLabel = status === "sent" ? verb.done : status === "sending" ? "Applying…" : status === "cancelled" ? "Closed" : status === "expired" ? "Expired" : "Awaiting your confirmation";
  return (
    <div className={`jv-card jv-draft jv-sched-change is-${status}`} data-testid="jarvis-schedule-change" role="group" aria-labelledby={titleId}>
      <div className="jv-card-heading">
        <span className="jv-card-symbol"><Icon name={status === "sent" ? "check" : verb.icon} /></span>
        <div className="jv-card-heading-copy">
          <span className="jv-card-kicker">Schedule change · {verb.label}</span>
          <h3 id={titleId}>In <span className="jv-where">{card.destination}</span></h3>
        </div>
      </div>
      <p className="jv-sched-text">{before.text}</p>
      <dl className="jv-sched-diff">
        <dt>Now</dt><dd>{describeSchedule(before.schedule)} · <span className={`jv-sched-status is-${before.status}`}>{before.status}</span></dd>
        <dt>After</dt><dd>{describeSchedule(card.after.schedule)} · <span className={`jv-sched-status is-${card.after.status}`}>{card.after.status}</span></dd>
      </dl>
      <RunTimes runs={card.after.next_runs} label={card.after.status === "paused" ? "Would resume at" : "Next runs"} />
      <DstNote note={card.dst_note} />
      <DstNote note={card.time_note} />
      <div className="jv-draft-state">
        <span className={status === "sent" ? "jv-done" : "jv-draft-status"}>{statusLabel}</span>
        {live && <Expiry left={left} />}
      </div>
      <p className="jv-confirm-hint">
        <Icon name={status === "sent" ? "check" : "lock"} />
        {status === "sent" ? "Done. See it in Schedules." : status === "cancelled" ? "This change is closed. Nothing was changed." : status === "expired" ? "Nothing was changed. Ask Agora again." : "Only applied after you confirm, and only if the schedule hasn't changed meanwhile."}
      </p>
      <div className="jv-draft-actions">
        {(status === "pending" || status === "sending") && <>
          <button className={`btn sm ${card.action === "cancel" ? "danger" : "primary"}`} disabled={!live} onClick={() => void sendDraftEntry(api, entry, card)}>
            <Icon name={verb.icon} />{status === "sending" ? "Applying…" : verb.label}
          </button>
          <button className="jv-discard" disabled={!live} onClick={e => {
            const panel = e.currentTarget.closest(".jv-panel");
            dismissCardEntry(api, entry);
            panel?.querySelector<HTMLInputElement>('[aria-label="Ask Agora"]')?.focus();
          }}><Icon name="trash-2" />Discard</button>
        </>}
      </div>
    </div>
  );
}

function ScheduleRow({ item }: { item: Schedule }) {
  const where = item.channel_kind === "agent_dm" ? item.channel_name ?? "DM" : `#${item.channel_name ?? "channel"}`;
  const next = item.next_runs[0];
  return (
    <li className="jv-sched-row">
      <span className="jv-msg-meta">
        <span className="jv-where">{where}{item.thread_id != null ? " · thread" : ""}</span>
        <span className={`jv-sched-status is-${item.status}`}>{item.status}</span>
      </span>
      <span className="jv-msg-text">{item.text}</span>
      <span className="jv-sched-meta"><Icon name="clock" />{describeSchedule(item.schedule)}{next ? ` · next ${formatLocal(next)}` : ""}</span>
      {item.last_error && <span className="jv-sched-error">{item.last_error}</span>}
    </li>
  );
}

function SchedulesListCard({ card }: { card: JarvisSchedulesCard }) {
  const titleId = useId();
  const first = card.offset + 1;
  const last = card.offset + card.items.length;
  return (
    <div className="jv-card jv-schedules" data-testid="jarvis-schedules" role="group" aria-labelledby={titleId}>
      <div className="jv-card-heading">
        <span className="jv-card-symbol"><Icon name="calendar-clock" /></span>
        <div className="jv-card-heading-copy">
          <span className="jv-card-kicker">Your schedules · {first === last ? first : `${first}–${last}`} of {card.total}{card.truncated ? "+" : ""}</span>
          <h3 id={titleId}>Scheduled messages</h3>
        </div>
      </div>
      <ul>{card.items.map(item => <ScheduleRow key={item.id} item={item} />)}</ul>
      {(card.has_more || card.truncated) && <p className="jv-card-empty">{card.has_more ? "More schedules exist. Ask Agora to show the next page." : "Older finished schedules aren't counted here."}</p>}
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
  if (isDraftLikeCard(entry.card) && (entry.status ?? "pending") === "pending") {
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
  if (card.kind === "schedule_draft") return <div className="jv-card-wrap">{close}<ScheduleDraftCard entry={entry} card={card} /></div>;
  if (card.kind === "schedule_change") return <div className="jv-card-wrap">{close}<ScheduleChangeCard entry={entry} card={card} /></div>;
  if (card.kind === "schedules") return <div className="jv-card-wrap">{close}<SchedulesListCard card={card} /></div>;
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
