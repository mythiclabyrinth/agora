/* Main channel pane (.agora-main when a channel is selected): header with
   rename/topic edit, pinned-threads bar, members toggle, the message log,
   live typing/progress rows, and the composer. */

import { useMemo, useState } from "react";
import {
  FEATURES, fmtTs, useAgents, useChannelAgents, useChannelLive, useClearMessages, useGroups, useMe, useMembers,
  usePinMessage, usePins, useSeedActivity, useStarMessage, useStars,
  useUpdateChannel, type Message,
} from "@agora/core";
import { useJump } from "../state/jump";
import { slugify } from "../lib/mentions";
import type { MentionCandidate } from "./Composer";
import { Icon } from "../lib/icons";
import { toast } from "../lib/toast";
import { useUiState } from "../state/ui";
import { buildMentionIndex } from "../lib/mentions";
import { MessageLog } from "./MessageLog";
import { Composer } from "./Composer";
import { LiveButton, LiveStrip, SpeakButton } from "./VoiceControls";
import { copyDeepLink } from "../lib/deepLinks";
import { confirmStep, useConfirm } from "../state/confirm";

function pinSnippet(m: { alias?: string | null; text?: string }): string {
  const alias = (m.alias || "").trim();
  if (alias) return alias;
  return (m.text || "").split("\n")[0].slice(0, 140);
}

function PinBar({ channelId }: { channelId: string }) {
  const pins = usePins(channelId).data || [];
  const pinMut = usePinMessage(channelId);
  const ui = useUiState();
  const [open, setOpen] = useState(false);
  if (!pins.length) return null;
  const first = pins[0];
  return (
    <div className="ago-pin-wrap">
      <button className={`ago-pinbar ${open ? "open" : ""}`} onClick={() => setOpen(!open)}
        title={open ? "Hide pinned threads" : "Show pinned threads"}>
        <span className="ago-pin-ico"><Icon name="pin" /></span>
        <span className="ago-pin-count">{pins.length} pinned</span>
        {!open && <span className="ago-pin-preview">{pinSnippet(first)}</span>}
        <span className="ago-pin-caret"><Icon name={open ? "chevron-up" : "chevron-down"} /></span>
      </button>
      {open && (
        <div className="ago-pin-pop">
          {pins.map(p => (
            <div key={p.id} className="ago-pin-row" title="Open thread"
              onClick={() => { setOpen(false); ui.openThread(p.id); }}>
              <div className="ago-pin-row-main">
                <span className="ago-pin-author">{(p as Message).author_name || (p as Message).author_id}</span>
                <span className="ago-pin-text">{pinSnippet(p)}</span>
              </div>
              <span className="ago-pin-meta">
                {p.reply_count ? `${p.reply_count} repl${p.reply_count === 1 ? "y" : "ies"} · ` : ""}{fmtTs(p.ts)}
              </span>
              <button className="ago-x" title="Unpin"
                onClick={e => { e.stopPropagation(); pinMut.mutate({ messageId: p.id, pinned: false }); }}>
                <Icon name="x" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* Starred-messages dropdown: rows jump to the message —
   into its thread when it's a reply, flashing it either way. */
function StarPop({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const stars = useStars(channelId).data || [];
  const starMut = useStarMessage(channelId);
  const ui = useUiState();
  const jump = useJump(s => s.request);
  return (
    <div className="ago-pin-wrap">
      <div className="ago-pin-pop">
        {stars.length ? stars.map(s => (
          <div key={s.id} className="ago-pin-row"
            title={s.thread_id != null ? "Open in its thread" : "Jump to message"}
            onClick={() => {
              onClose();
              if (s.thread_id != null) {
                ui.openThread(s.thread_id);
                jump({ mid: s.id, container: "thread" });
              } else {
                jump({ mid: s.id, container: "log" });
              }
            }}>
            <div className="ago-pin-row-main">
              <span className="ago-pin-author">{s.author_name || s.author_id}</span>
              <span className="ago-pin-text">{pinSnippet(s)}</span>
            </div>
            <span className="ago-pin-meta">{s.thread_id != null ? "in thread · " : ""}{fmtTs(s.ts)}</span>
            <button className="ago-x" title="Unstar"
              onClick={e => { e.stopPropagation(); starMut.mutate({ messageId: s.id, starred: false }); }}>
              <Icon name="x" />
            </button>
          </div>
        )) : (
          <div className="dim" style={{ padding: "10px 12px", fontSize: 12 }}>
            Nothing starred in this channel yet — hover a message and hit <Icon name="star" /> star.
          </div>
        )}
      </div>
    </div>
  );
}

export function LiveRows({ channelId, threadId }: { channelId: string; threadId: number | null }) {
  const { typing, progress } = useChannelLive(channelId, threadId);
  const activeTyping = typing.filter(t => !progress.some(p => p.agent_name === t.agent_name));
  if (!typing.length && !progress.length) {
    return <div className="ago-status" id={threadId != null ? "ago-thread-status" : "ago-status"}></div>;
  }
  return (
    <div className="ago-status" id={threadId != null ? "ago-thread-status" : "ago-status"}>
      {progress.map(p => (
        <div key={p.handle} className="ago-progress">
          <Icon name="loader" cls="spin" /> <b>{p.agent_name}</b> <span className="ago-progress-detail">{p.text}</span>
        </div>
      ))}
      {activeTyping.length > 0 && (
        <div className="ago-typing">
          {activeTyping.map(t => t.agent_name).join(", ")} typing<span className="dots">…</span>
        </div>
      )}
    </div>
  );
}

function AgentHint({ username, channelId, onOpen }: { username: string; channelId: string; onOpen: () => void }) {
  const storageKey = `agora_agent_hint:${JSON.stringify([username, channelId])}`;
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(storageKey) === "dismissed"; } catch { return false; }
  });
  if (dismissed) return null;
  return <div className="ago-hint-banner">
    <span>Bring an agent into the conversation.</span>
    <button className="lnk" onClick={onOpen}>Add members</button>
    <button className="ago-x" aria-label="Dismiss agent suggestion" onClick={() => {
      setDismissed(true);
      try { localStorage.setItem(storageKey, "dismissed"); } catch { /* Still dismiss for this visit when storage is unavailable. */ }
    }}><Icon name="x" /></button>
  </div>;
}

export function ChannelPane() {
  const ui = useUiState();
  const me = useMe().data;
  const groups = useGroups().data || [];
  const group = groups.find(g => g.id === ui.sel.g) || null;
  const channel = group?.channels?.find(c => c.id === ui.sel.c) || null;
  const agents = useChannelAgents(channel?.id || "").data || [];
  // The channel-agents payload is {id, name} only; avatars live on the full
  // /api/agents roster, so the picker/mention rows resolve them by id (the
  // same lookup the vanilla UI and MessageItem do).
  const roster = useAgents().data || [];
  useSeedActivity(channel?.id || "");
  const updateChannel = useUpdateChannel();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editTopic, setEditTopic] = useState("");
  const [replyInThread, setReplyInThread] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [starsOpen, setStarsOpen] = useState(false);
  const stars = useStars(channel?.id || "").data || [];
  const clearChat = useClearMessages(channel?.id || "", null);
  const clearArmed = useConfirm(s => s.armed) === `clear-chat:${channel?.id}`;

  const isDm = channel?.kind === "agent_dm";
  const members = useMembers(isDm ? "" : (group?.id || "")).data || [];
  const isAdmin = !!(!isDm && group && (
    group.role === "admin" || channel?.role === "admin" || me?.instance_admin
  ));
  const mentions = useMemo(
    () => buildMentionIndex(
      agents.map(a => ({ id: a.id, name: a.name })),
      members.filter(m => m.member_type === "user").map(m => m.member_id),
    ),
    [agents, members],
  );
  const candidates = useMemo<MentionCandidate[]>(() => {
    const me_ = me?.username;
    return [
      ...agents.map(a => ({
        type: "agent" as const, id: a.id, name: a.name, slug: slugify(a.name),
        avatar: roster.find(r => r.id === a.id)?.avatar || undefined,
      })),
      ...members
        .filter(m => m.member_type === "user" && m.member_id !== me_)
        .map(m => ({ type: "user" as const, id: m.member_id, name: m.member_id, slug: m.member_id })),
    ];
  }, [agents, roster, members, me]);

  if (!channel || !group) {
    return (
      <div className="agora-main" id="agora-main">
        <div className="ago-head ago-head-empty">
          <button className="btn sm ago-back" title="Back to groups" onClick={() => ui.backToGroups()}>
            <Icon name="chevron-left" />
          </button>
          <div className="ago-head-text"><span className="ago-chan-name">Agora</span></div>
        </div>
        <div className="empty">
          <div className="glyph"><Icon name="layout-grid" /></div>
          <div>{group ? "No channel selected" : "Welcome to Agora"}</div>
          <div className="hint">{group
            ? "Pick or create a channel in this group to start chatting."
            : "Create a group on the left, add channels inside it, then invite agents to chat with."}</div>
        </div>
      </div>
    );
  }

  const saveEdit = () => {
    if (!editName.trim()) { toast("Rename failed: channel name can't be empty", { variant: "warn" }); return; }
    updateChannel.mutate(
      { groupId: group.id, channelId: channel.id, name: editName.trim(), topic: editTopic.trim() },
      {
        onSuccess: () => setEditing(false),
        onError: e => toast("Couldn't update channel: " + (e as Error).message, { variant: "warn" }),
      },
    );
  };

  return (
    <div className="agora-main" id="agora-main">
      <div className="ago-head">
        <button className="btn sm ago-back" title="Back to groups" onClick={() => ui.backToGroups()}>
          <Icon name="chevron-left" />
        </button>
        {editing ? (
          <div className="ago-head-text ago-chan-edit">
            <input id="ago-edit-name" autoFocus value={editName} placeholder="Channel name"
              aria-label="Channel name"
              onChange={e => setEditName(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !updateChannel.isPending) saveEdit();
                if (e.key === "Escape") setEditing(false);
              }} />
            <input id="ago-edit-topic" value={editTopic} placeholder="Description (optional)"
              aria-label="Channel description"
              onChange={e => setEditTopic(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !updateChannel.isPending) saveEdit();
                if (e.key === "Escape") setEditing(false);
              }} />
            <div className="ago-chan-edit-actions">
              <button className="btn sm primary" disabled={!editName.trim() || updateChannel.isPending} onClick={saveEdit}>Save</button>
              <button className="btn sm" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="ago-head-text">
            <span className="ago-chan-name"><span className="hash">{isDm ? "↔" : "#"}</span>{channel.name}</span>
            <span className="ago-chan-topic">
              <span className="dim" title={channel.topic || ""}>{isDm ? "Private agent conversation" : (channel.topic || group.name)}</span>
              {isAdmin && (
                <button className="ago-edit-btn" title={`Rename #${channel.name} / edit topic`}
                  onClick={() => { setEditing(true); setEditName(channel.name); setEditTopic(channel.topic || ""); }}>
                  <Icon name="pencil" />
                </button>
              )}
            </span>
          </div>
        )}
        <button className="btn sm ago-mobile-tools" aria-label="Channel actions" aria-expanded={toolsOpen}
          onClick={() => setToolsOpen(!toolsOpen)}><Icon name="chevron-down" /></button>
        <div className={`ago-head-actions ago-channel-tools ${toolsOpen ? "open" : ""}`}>
          <button className={`btn sm ${ui.filesOpen && ui.filesThread == null ? "active" : ""}`}
            title={`Attachments in #${channel.name}`}
            onClick={() => ui.setFilesOpen(!(ui.filesOpen && ui.filesThread == null), null)}>
            <Icon name="paperclip" /> Files
          </button>
          {(isDm || isAdmin) && <button
            className={`btn sm danger ${clearArmed ? "armed" : ""}`}
            disabled={clearChat.isPending}
            title={clearArmed ? "Click again to clear all messages" : `Clear all messages in ${isDm ? "this chat" : `#${channel.name}`}`}
            onClick={() => {
              if (!confirmStep(`clear-chat:${channel.id}`)) return;
              clearChat.mutate(undefined, {
                onSuccess: result => {
                  ui.setFilesOpen(false);
                  toast(result.deleted ? `Cleared ${result.deleted} messages` : "Chat is already empty");
                },
                onError: e => toast(`Couldn't clear chat: ${(e as Error).message}`, { variant: "warn" }),
              });
            }}>
            <Icon name="trash-2" /> {clearArmed ? "Clear all?" : "Clear chat"}
          </button>}
          {!isDm && <button className="btn sm" title="Copy link to this channel"
            onClick={() => void copyDeepLink({
              kind: "channel", groupId: group.id, channelId: channel.id,
            }, "Channel")}>
            <Icon name="link" /> Link
          </button>}
          {me?.voice_tts && <SpeakButton />}
          {me?.voice_stt && me?.voice_tts && <LiveButton channelId={channel.id} threadId={null} />}
          {FEATURES.stars && <button className={`btn sm ago-star-toggle ${starsOpen ? "active" : ""}`}
            title={`Starred messages in #${channel.name}`}
            onClick={() => setStarsOpen(!starsOpen)}>
            {stars.length ? <><Icon name="star" cls="fill" /> {stars.length}</> : <Icon name="star" />}
          </button>}
          {!isDm && <button className={`btn sm ${ui.membersOpen ? "active" : ""}`}
            onClick={() => ui.setMembersOpen(!ui.membersOpen)}>Members</button>}
        </div>
      </div>
      <PinBar channelId={channel.id} />
      {FEATURES.stars && starsOpen && <StarPop channelId={channel.id} onClose={() => setStarsOpen(false)} />}
      {!agents.length && !isDm && me && <AgentHint key={JSON.stringify([me.username, channel.id])}
        username={me.username} channelId={channel.id} onOpen={() => ui.setMembersOpen(true)} />}
      {isDm && channel.dm_can_post === false && <div className="ago-hint-banner">
        Your access to this agent has been removed. This conversation is a read-only archive.
      </div>}
      <MessageLog channelId={channel.id} isAdmin={isAdmin} mentions={mentions}
        onOpenThread={rootId => ui.openThread(rootId)} />
      <LiveRows channelId={channel.id} threadId={null} />
      <LiveStrip channelId={channel.id} threadId={null} />
      {(!isDm || channel.dm_can_post !== false) && <Composer channelId={channel.id} channelName={channel.name} groupId={group.id} threadId={null}
        agents={agents} candidates={isDm ? [] : candidates} voiceOK={!!me?.voice_stt}
        replyInThread={replyInThread}
        onSetReplyInThread={setReplyInThread} />}
    </div>
  );
}
