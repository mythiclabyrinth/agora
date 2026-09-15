/* Conversation row shared by channel history and thread replies. */

import { useEffect, useLayoutEffect, useId, useRef, useState } from "react";
import { create } from "zustand";
import {
  fmtTs, tldrOf, useAgents, useDeleteMessage, useEditMessage, useMe, usePinMessage, usePins,
  FEATURES, useStarMessage, useStars, useTldrView, type LinkPreview, type Message,
} from "@agora/core";
import { watchAnchoredOverlay } from "../lib/anchoredOverlay";
import { Icon } from "../lib/icons";
import { toast } from "../lib/toast";
import { useConfirm } from "../state/confirm";
import { type MentionIndex } from "../lib/mentions";
import { MdText } from "./MdText";
import { Attachments } from "./Attachments";
import { Unfurls, urlHost } from "./Unfurls";
import { MessageInfoDialog } from "./MessageInfoDialog";
import { MessageOptions } from "./MessageOptions";
import { MessageFormView } from "./MessageFormView";
import { MessageTableView } from "./MessageTableView";
import { Reactions } from "./Reactions";
import { useEmojiPicker } from "./EmojiPicker";
import { ArtifactList } from "./artifacts/ArtifactList";
import { useUiState } from "../state/ui";
import { copyDeepLink } from "../lib/deepLinks";
import { AgentAvatar as SharedAgentAvatar } from "./AgentAvatar";

const messageTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/* Source viewer state (the overlay itself mounts app-level). */
interface SourcesView {
  open: { message: Message; index: number } | null;
  show: (message: Message, index: number) => void;
  close: () => void;
}
export const useSourcesView = create<SourcesView>((set) => ({
  open: null,
  show: (message, index) => set({ open: { message, index } }),
  close: () => set({ open: null }),
}));

/* The text a bubble renders: cut a trailing "Sources:" block the server
   lifted into meta.sources. */
function visibleText(m: Message): string {
  const meta = m.meta || {};
  const cut = meta.sources_start;
  if (Array.isArray(meta.sources) && meta.sources.length
    && Number.isInteger(cut) && (cut as number) > 0 && (cut as number) < (m.text || "").length) {
    return m.text.slice(0, cut as number).replace(/\s+$/, "");
  }
  return m.text;
}

function AgentAvatar({ agentId }: { agentId: string }) {
  const agents = useAgents().data || [];
  const meta = agents.find(a => a.id === agentId);
  const title = `View ${meta?.name || agentId}'s profile`;
  const onClick = () => useAgentProfile.getState().show(agentId);
  return <SharedAgentAvatar agentId={agentId} className="clickable" title={title} onClick={onClick} />;
}

/* Agent profile card state (overlay mounts app-level, Phase 5). */
interface AgentProfileState {
  openId: string | null;
  show: (id: string) => void;
  close: () => void;
}
export const useAgentProfile = create<AgentProfileState>((set) => ({
  openId: null,
  show: (id) => set({ openId: id }),
  close: () => set({ openId: null }),
}));

function SourceChips({ message }: { message: Message }) {
  const sources = (message.meta?.sources || []) as LinkPreview[];
  if (!sources.length) return null;
  return (
    <div className="ago-sources">
      <span className="ago-sources-label"><Icon name="link" /> sources</span>
      {sources.map((s, i) => (
        <button key={i} className="ago-source-chip"
          title={s.title ? `${s.title}\n${s.url}` : s.url}
          onClick={() => useSourcesView.getState().show(message, i)}>
          <span className="n">{i + 1}</span>
          <span className="t">{s.title || urlHost(s.url) || s.url}</span>
        </button>
      ))}
    </div>
  );
}

export function MessageItem({ message: m, inThread, isAdmin, mentions, onOpenThread, grouped = false }: {
  message: Message;
  grouped?: boolean;
  inThread: boolean;
  isAdmin: boolean;
  mentions?: MentionIndex;
  onOpenThread: (rootId: number) => void;
}) {
  const me = useMe().data;
  const mine = m.author_type === "user" && !!me && m.author_id === me.username;
  const cls = m.author_type === "agent" ? "assistant" : (mine ? "user" : "assistant peer");

  const pins = usePins(m.channel_id).data || [];
  const stars = useStars(m.channel_id).data || [];
  const pinMut = usePinMessage(m.channel_id);
  const starMut = useStarMessage(m.channel_id);
  const del = useDeleteMessage();
  const edit = useEditMessage();
  const { showing, toggle: toggleTldr } = useTldrView();
  const armed = useConfirm(s => s.armed) === `msg:${m.id}`;
  const armKey = useConfirm(s => s.arm);
  const disarm = useConfirm(s => s.disarm);
  const openPicker = useEmojiPicker(s => s.open);
  const groupId = useUiState(s => s.sel.g);
  const [showInfo, setShowInfo] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!actionsOpen || !menuRef.current || !menuButtonRef.current) return;
    return watchAnchoredOverlay(menuButtonRef.current, menuRef.current, "center");
  }, [actionsOpen]);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(m.text);
  const editRef = useRef<HTMLTextAreaElement>(null);

  const pinnable = m.thread_id == null;
  const pinned = pinnable && pins.some(p => p.id === m.id);
  const starred = stars.some(s => s.id === m.id);
  const tldr = tldrOf(m);
  const onTldr = tldr != null && !!showing[m.id];

  useEffect(() => { if (!editing) setEditText(m.text); }, [m.text, editing]);
  useEffect(() => { if (editing) editRef.current?.focus(); }, [editing]);

  const cancelEdit = () => { setEditText(m.text); setEditing(false); };
  const saveEdit = () => {
    const text = editText.trim();
    if (!text || edit.isPending) return;
    edit.mutate({ message: m, text }, {
      onSuccess: () => setEditing(false),
      onError: (e) => toast("Edit failed: " + (e as Error).message, { variant: "warn" }),
    });
  };
  const openEdit = () => {
    setEditText(m.text);
    if (onTldr) toggleTldr(m.id);
    menuRef.current?.hidePopover();
    setEditing(true);
  };

  const onDelete = () => {
    if (!armed) { armKey(`msg:${m.id}`); return; }
    disarm();
    del.mutate({ message: m }, {
      onError: (e) => toast("Delete failed: " + (e as Error).message, { variant: "warn" }),
    });
  };

  const bubble = (
    <div className={`bubble ${cls} ago-bubble`} data-mid={m.id} title={fmtTs(m.ts)}
      onKeyDown={e => {
        if (e.key === "Escape" && actionsOpen) {
          e.stopPropagation();
          menuRef.current?.hidePopover();
          menuButtonRef.current?.focus();
        }
      }}>
      <div className="who">
        <span className="who-name">
          {(m.author_name || m.author_id)}{m.author_type === "agent" ? " · agent" : ""}
        </span>
        {pinned && <span className="ago-pinned-mark" title="Pinned"><Icon name="pin" /></span>}
        {FEATURES.stars && starred && <span className="ago-starred-mark" title="Starred by you"><Icon name="star" cls="fill" /></span>}
        {onTldr && <span className="ago-tldr-mark" title="Short version — the full message is one click away">TL;DR</span>}
        <time className="bubble-ts" dateTime={new Date(m.ts * 1000).toISOString()} title={fmtTs(m.ts)}>{m.meta?.edited_at ? "edited · " : ""}{messageTime.format(m.ts * 1000)}</time>
      </div>
      {editing ? (
        <div className="ago-message-edit">
          <textarea ref={editRef} value={editText} aria-label="Edit message"
            onChange={e => setEditText(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Escape") cancelEdit();
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                saveEdit();
              }
            }} />
          <div className="ago-message-edit-actions">
            <button className="btn sm" onClick={cancelEdit} disabled={edit.isPending}>Cancel</button>
            <button className="btn sm primary" onClick={saveEdit}
              disabled={!editText.trim() || edit.isPending}>
              {edit.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : m.text || m.attachments?.length ? (
        <MdText text={onTldr ? (tldr as string) : visibleText(m)} mentions={mentions} />
      ) : <div className="ago-attachment-deleted">Attachment deleted</div>}
      <ArtifactList artifacts={m.meta?.artifacts} />
      <Attachments message={m} />
      <Unfurls message={m} />
      <SourceChips message={m} />
      <MessageFormView message={m} />
      <MessageTableView message={m} />
      <MessageOptions message={m} />
      <Reactions message={m} onPick={(anchor) => openPicker(m.id, anchor)} />
        <div className={`ago-message-actions ${actionsOpen ? "open" : ""}`}>
        {!inThread && (
          <button className="ago-thread-btn" title="Reply in thread" onClick={() => onOpenThread(m.id)}>
            <Icon name="corner-down-right" />
          </button>
        )}
        <button className="ago-thread-btn ago-react-btn" title="Add reaction"
          onClick={e => openPicker(m.id, e.currentTarget)}>
          <Icon name="smile" />
        </button>
        {groupId && (
          <button className="ago-thread-btn" title="Copy link to this message"
            onClick={() => void copyDeepLink({
              kind: "message",
              groupId,
              channelId: m.channel_id,
              threadId: m.thread_id,
              messageId: m.id,
            }, "Message")}>
            <Icon name="link" />
          </button>
        )}
        <button ref={menuButtonRef} className="ago-thread-btn ago-message-menu" aria-expanded={actionsOpen}
          aria-label="More message actions" popoverTarget={menuId}>
          <Icon name="ellipsis" />
        </button>
        <div id={menuId} ref={menuRef} popover="auto" className="ago-message-secondary"
          aria-label="Additional message actions"
          onToggle={e => setActionsOpen(e.newState === "open")}>
        <button className="ago-thread-btn ago-info-btn" title="Message info" onClick={() => {
          menuRef.current?.hidePopover();
          menuButtonRef.current?.focus();
          setShowInfo(true);
        }}><Icon name="info" /> Details</button>
        {pinnable && (
          <button className={`ago-thread-btn ago-pin-btn ${pinned ? "pinned" : ""}`}
            title={pinned ? "Unpin this thread" : "Pin this thread for quick access"}
            onClick={() => pinMut.mutate({ messageId: m.id, pinned: !pinned })}>
            {pinned ? <><Icon name="pin-off" /> unpin</> : <><Icon name="pin" /> pin</>}
          </button>
        )}
        {FEATURES.stars && <button className={`ago-thread-btn ago-star-btn ${starred ? "starred" : ""}`}
          title={starred ? "Remove from your starred messages" : "Star this message"}
          onClick={() => starMut.mutate({ messageId: m.id, starred: !starred })}>
          {starred ? <><Icon name="star" cls="fill" /> starred</> : <><Icon name="star" /> star</>}
        </button>}
        {tldr != null && (
          <button className={`ago-thread-btn ago-tldr-btn ${onTldr ? "on" : ""}`}
            title={onTldr ? "Show the full message" : "Show the short version"}
            onClick={() => toggleTldr(m.id)}>
            {onTldr ? <><Icon name="maximize-2" /> full</> : <><Icon name="minimize-2" /> tl;dr</>}
          </button>
        )}
        {mine && !!m.text.trim() && !editing && (
          <button className="ago-thread-btn ago-edit-btn" title="Edit this message" onClick={openEdit}>
            <Icon name="pencil" /> edit
          </button>
        )}
        {(mine || isAdmin) && (
          <button className={`ago-thread-btn ago-del-btn ${armed ? "armed" : ""}`}
            title={armed ? "Click again to delete for everyone" : "Delete this message"}
            onClick={onDelete}>
            <Icon name="trash-2" /> {armed ? "sure?" : "delete"}
          </button>
        )}
        </div>
        </div>
      <div className="ago-bubble-foot">
        {!inThread && !!m.reply_count && (
          <button className="ago-replies" onClick={() => onOpenThread(m.id)}>
            {m.reply_count} repl{m.reply_count === 1 ? "y" : "ies"} →
          </button>
        )}
        {/* A named thread tells its roots apart when the text cannot — a channel
            of identical "/new ~/project" roots is otherwise unreadable. Last in
            the foot and pushed right by margin-left:auto, so it lands in the
            bubble's bottom-right corner and never crowds the message body. */}
        {!inThread && !!m.reply_count && !!m.alias?.trim() && (
          <span className="ago-thread-alias" title={m.alias.trim()}>{m.alias.trim()}</span>
        )}
      </div>
    </div>
  );

  return <><div className={`ago-msg-row ${mine ? "is-mine" : "is-peer"} ${grouped && !pinned && !starred && !onTldr && !m.meta?.edited_at ? "grouped" : ""}`}>
    {m.author_type === "agent" ? <AgentAvatar agentId={m.author_id} /> : (
      <span className={`ago-av ago-person-avatar ${mine ? "mine" : ""}`} aria-hidden="true">
        {(m.author_name || m.author_id).slice(0, 2).toUpperCase()}
      </span>
    )}
    {bubble}
  </div>
    {showInfo && <MessageInfoDialog message={m} groupId={groupId || undefined} onClose={() => setShowInfo(false)} />}
  </>;
}
