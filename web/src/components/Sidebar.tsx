/* Sidebar (.agora-side): Threads inbox entry, the groups/channels tree with
   unread badges and per-row hide/delete, recent side-threads, the hidden
   section, unreads-only filter, collapse rail, and inline create rows —
   the React port of agoDrawSide. */

import { useMemo, useRef, useState } from "react";
import {
  FEATURES,
  useCreateChannel, useCreateGroup, useDeleteChannel, useGroups, useHideThread,
  useMe, useRenameThread, useReorderChannels, useReorderGroups, useSetGroupHidden,
  useThreads, useUpdateChannel,
  type Channel, type Group, type ThreadRow,
} from "@agora/core";
import { Icon } from "../lib/icons";
import { toast } from "../lib/toast";
import { useConfirm } from "../state/confirm";
import { useUiState } from "../state/ui";
import { AgentDmPanel } from "./AgentDmPanel";
import { PromptDialog } from "./ThreadRenameDialog";

const SEARCH_KEY = /Mac|iPhone|iPad/.test(navigator.platform || "") ? "⌘K" : "Ctrl+K";

function Badge({ n, mentions }: { n: number; mentions: number }) {
  if (mentions > 0) {
    return (
      <span className="ago-unread-badge mention" title={`${mentions} mention${mentions === 1 ? "" : "s"}`}>
        @ {mentions > 99 ? "99+" : mentions}
      </span>
    );
  }
  return n > 0 ? <span className="ago-unread-badge">{n > 99 ? "99+" : n}</span> : null;
}

function pinSnippet(m: { alias?: string | null; text?: string }): string {
  const alias = (m.alias || "").trim();
  if (alias) return alias;
  return (m.text || "").split("\n")[0].slice(0, 140);
}

/* Threads of a channel worth surfacing: unread, or active in the last 48h,
   capped at 5 (mirrors agoChannelThreads). */
function channelThreads(threads: ThreadRow[], cid: string): ThreadRow[] {
  const cutoff = Date.now() / 1000 - 48 * 3600;
  return threads
    .filter(t => t.channel_id === cid
      && ((t.unread || 0) > 0 || (t.last_reply_ts || 0) > cutoff))
    .slice(0, 5);
}

function SideThread({ t, g, c }: { t: ThreadRow; g: Group; c: Channel }) {
  const ui = useUiState();
  const hide = useHideThread();
  const rename = useRenameThread();
  const armed = useConfirm(s => s.armed) === `thr:${t.root.id}`;
  const arm = useConfirm(s => s.arm);
  const disarm = useConfirm(s => s.disarm);
  const snippet = pinSnippet(t.root || {});
  const [renaming, setRenaming] = useState(false);
  return (
    <div className={`ago-side-thread ${t.unread ? "unread" : ""}`} title={snippet}
      onClick={e => {
        e.stopPropagation();
        ui.selectChannel(g.id, c.id);
        ui.openThread(t.root.id, "replace");
      }}>
      <span className="tico"><Icon name="corner-down-right" /></span>
      <span className="nm">{snippet}</span>
      <Badge n={t.unread || 0} mentions={0} />
      <button className="ago-x" title="Rename this thread"
        onClick={e => {
          e.stopPropagation();
          setRenaming(true);
        }}>
        <Icon name="pencil" />
      </button>
      {renaming && <PromptDialog title="Rename thread"
        description="Leave the name blank to use the first line of the thread."
        label="Thread name" value={t.root.alias || ""} pending={rename.isPending}
        onClose={() => setRenaming(false)} onSave={alias => rename.mutate(
          { threadId: t.root.id, alias },
          {
            onSuccess: () => setRenaming(false),
            onError: error => toast(`Couldn't rename thread: ${(error as Error).message}`, { variant: "warn" }),
          },
        )} />}
      <button className={`ago-x ${armed ? "armed" : ""}`}
        title={armed ? "Click again to remove this thread" : "Remove thread from your sidebar (messages stay in the channel)"}
        onClick={e => {
          e.stopPropagation();
          if (!armed) { arm(`thr:${t.root.id}`); return; }
          disarm();
          hide.mutate(t.root.id);
        }}>
        {armed ? "Sure?" : <Icon name="x" />}
      </button>
    </div>
  );
}

export function Sidebar() {
  const me = useMe().data;
  const groups = useGroups().data || [];
  const orderedGroups = [...groups.filter(g => g.kind !== "agent_dms"), ...groups.filter(g => g.kind === "agent_dms")];
  const threads = useThreads().data || [];
  const ui = useUiState();
  const armedKey = useConfirm(s => s.armed);
  const arm = useConfirm(s => s.arm);
  const disarm = useConfirm(s => s.disarm);
  const createGroup = useCreateGroup();
  const createChannel = useCreateChannel();
  const deleteChannel = useDeleteChannel();
  const updateChannel = useUpdateChannel();
  const setGroupHidden = useSetGroupHidden();
  const [creating, setCreating] = useState<{ kind: "group" } | { kind: "channel"; g: string } | null>(null);
  const [createName, setCreateName] = useState("");
  const [dmOpen, setDmOpen] = useState(false);
  const reorderGroups = useReorderGroups();
  const reorderChannels = useReorderChannels();
  /* Drag-to-reorder, mirroring agoDragStart/agoDragOverRow/agoDropRow:
     groups reorder among groups, channels among their own group's channels;
     the dropped-on row shifts down. */
  const dragRef = useRef<{ type: "group" | "chan"; id: string; gid: string | null } | null>(null);
  const dragStart = (type: "group" | "chan", id: string, gid?: string) =>
    (ev: React.DragEvent) => {
      dragRef.current = { type, id, gid: gid || null };
      ev.dataTransfer.effectAllowed = "move";
      try { ev.dataTransfer.setData("text/plain", id); } catch { /* older engines */ }
    };
  const dragOver = (type: "group" | "chan", gid?: string) =>
    (ev: React.DragEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.type !== type) return;
      if (type === "chan" && drag.gid !== (gid || null)) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
    };
  const dropOn = (type: "group" | "chan", id: string, gid?: string) =>
    (ev: React.DragEvent) => {
      ev.preventDefault();
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag || drag.type !== type || drag.id === id) return;
      const err = (e: unknown) =>
        toast("Couldn't reorder: " + ((e as Error).message || e), { variant: "warn" });
      if (type === "chan") {
        if (drag.gid !== (gid || null) || !gid) return;
        const g = groups.find(x => x.id === gid);
        if (!g) return;
        const ids = (g.channels || []).map(c => c.id).filter(x => x !== drag.id);
        const at = ids.indexOf(id);
        ids.splice(at < 0 ? ids.length : at, 0, drag.id);
        reorderChannels.mutate({ groupId: gid, ids }, { onError: err });
      } else {
        const ids = groups.filter(x => x.kind !== "agent_dms").map(x => x.id).filter(x => x !== drag.id);
        const at = ids.indexOf(id);
        ids.splice(at < 0 ? ids.length : at, 0, drag.id);
        reorderGroups.mutate(ids, { onError: err });
      }
    };

  const isOwner = !!me?.instance_admin;
  const unreadOf = (c: Channel) => c.unread || 0;
  const mentionsOf = (c: Channel) => c.mentions || 0;
  const groupUnread = (g: Group) =>
    (g.channels || []).filter(c => !c.hidden).reduce((n, c) => n + unreadOf(c), 0);
  const groupMentions = (g: Group) =>
    (g.channels || []).filter(c => !c.hidden).reduce((n, c) => n + mentionsOf(c), 0);
  const threadTotal = useMemo(() => threads.reduce((n, t) => n + (t.unread || 0), 0), [threads]);
  const anyUnread = groups.some(g => groupUnread(g) > 0) || threadTotal > 0;
  const anyMention = groups.some(g => groupMentions(g) > 0);

  const submitCreate = () => {
    const name = createName.trim();
    if (!name || !creating) return;
    if (creating.kind === "group") {
      createGroup.mutate({ name }, {
        onError: e => toast("Couldn't create group: " + (e as Error).message, { variant: "warn" }),
      });
    } else {
      createChannel.mutate({ groupId: creating.g, name }, {
        onError: e => toast("Couldn't create channel: " + (e as Error).message, { variant: "warn" }),
      });
    }
    setCreating(null);
    setCreateName("");
  };

  const createRow = (
    <div className="ago-create">
      <input id={creating?.kind === "group" ? "ago-new-group" : "ago-new-channel"} autoFocus
        placeholder={creating?.kind === "group" ? "group name" : "channel name"}
        value={createName}
        onChange={e => setCreateName(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter") submitCreate();
          if (e.key === "Escape") { setCreating(null); setCreateName(""); }
        }} />
      <button className="btn sm" onClick={submitCreate}>Add</button>
    </div>
  );

  const hiddenGroups = groups.filter(g => g.hidden);
  const hiddenChans = groups.filter(g => !g.hidden)
    .flatMap(g => (g.channels || []).filter(c => c.hidden).map(c => ({ g, c })));
  const hiddenCount = hiddenGroups.length + hiddenChans.length;

  return (
    <div className="agora-side" id="agora-side">
      <div className="side-title">
        <span>Groups</span>
        <span className="side-title-actions">
          <button className="ago-side-toggle search" title={`Search (${SEARCH_KEY})`}
            onClick={() => ui.setSearchOpen(true)}><Icon name="search" /></button>
          <button className={`ago-side-toggle filter ${ui.unreadsOnly ? "on" : ""}`}
            title={ui.unreadsOnly ? "Show all channels" : "Show unreads only"}
            onClick={() => ui.setUnreadsOnly(!ui.unreadsOnly)}><Icon name="circle-dot" /></button>
          <button className="ago-side-toggle collapse" title="Collapse groups"
            onClick={() => ui.toggleSide()}><Icon name="chevrons-left" /></button>
        </span>
      </div>
      <button className="ago-side-toggle expand" title="Show groups"
        onClick={() => ui.toggleSide()}><Icon name="chevrons-right" /></button>
      {anyUnread && <span className={`ago-side-dot ${anyMention ? "mention" : ""}`} title="Unread messages"></span>}
      <div className={`ago-inbox-item ${ui.view.kind === "inbox" ? "active" : ""} ${threadTotal ? "unread" : ""}`}
        onClick={() => ui.openInbox()}>
        <span className="tico"><Icon name="messages-square" /></span><span className="nm">Threads</span>
        <Badge n={threadTotal} mentions={0} />
      </div>
      <div className="ago-groups">
        {orderedGroups.filter(g => !g.hidden).map(g => {
          const open = ui.isExpanded(g.id);
          const sel = g.id === ui.sel.g;
          const isDms = g.kind === "agent_dms";
          const admin = !isDms && (g.role === "admin" || isOwner);
          return (
            <div key={g.id} className={`ago-group ${open ? "open" : ""} ${sel ? "sel" : ""}`}>
              <div className={`ago-group-head ${groupUnread(g) || groupMentions(g) ? "unread" : ""}`}
                title={`Open ${g.name}`}
                draggable={!isDms}
                onDragStart={dragStart("group", g.id)}
                onDragOver={isDms ? undefined : dragOver("group")}
                onDrop={isDms ? undefined : dropOn("group", g.id)}
                onClick={() => ui.openGroupPage(g.id)}>
                <span className={`ago-caret ${open ? "open" : ""}`}
                  title={`${open ? "Collapse" : "Expand"} ${g.name}`}
                  onClick={e => { e.stopPropagation(); ui.toggleGroup(g.id); }}>
                  <Icon name="chevron-right" />
                </span>
                <span className="ago-group-title"><span className="nm">{g.name}</span></span>
                {!open && <Badge n={groupUnread(g)} mentions={groupMentions(g)} />}
                <span className="role">{g.role || ""}</span>
              </div>
              {open && (g.channels || []).filter(c => !c.hidden).map(c => {
                const unread = unreadOf(c), mentions = mentionsOf(c);
                const chThreads = channelThreads(threads, c.id);
                const threadUnread = chThreads.reduce((n, t) => n + (t.unread || 0), 0);
                const threadsCollapsed = ui.isChannelCollapsed(c.id);
                const active = sel && c.id === ui.sel.c && ui.view.kind === "channel";
                if (ui.unreadsOnly && !unread && !mentions && !threadUnread && !active) return null;
                const chArmed = armedKey === `chan:${c.id}`;
                return (
                  <div key={c.id}>
                    <div className={`ago-chan ${active ? "active" : ""} ${unread || mentions || (threadsCollapsed && threadUnread) ? "unread" : ""}`}
                      draggable={!isDms}
                      onDragStart={isDms ? undefined : dragStart("chan", c.id, g.id)}
                      onDragOver={isDms ? undefined : dragOver("chan", g.id)}
                      onDrop={isDms ? undefined : dropOn("chan", c.id, g.id)}
                      onClick={() => ui.selectChannel(g.id, c.id)}>
                      {chThreads.length ? (
                        <button type="button" className={`ago-caret ago-chan-caret ${threadsCollapsed ? "" : "open"}`}
                          aria-expanded={!threadsCollapsed}
                          aria-controls={threadsCollapsed ? undefined : `ago-channel-threads-${c.id}`}
                          aria-label={`${threadsCollapsed ? "Expand" : "Collapse"} threads in #${c.name}`}
                          onClick={event => { event.stopPropagation(); ui.toggleChannelThreads(c.id); }}>
                          <Icon name="chevron-right" />
                        </button>
                      ) : <span className="ago-chan-caret-spacer" aria-hidden="true" />}
                      <span className="hash">{isDms ? "↔" : "#"}</span><span className="nm">{c.name}</span>
                      <Badge n={threadsCollapsed ? unread + threadUnread : unread} mentions={mentions} />
                      {!isDms && <button className="ago-x hide" title={`Hide #${c.name} from your sidebar`}
                        onClick={e => {
                          e.stopPropagation();
                          updateChannel.mutate({ groupId: g.id, channelId: c.id, hidden: true }, {
                            onSuccess: () => toast(`#${c.name} hidden for you — find it under Hidden below the groups`),
                          });
                        }}>
                        <Icon name="eye-off" />
                      </button>}
                      {admin && (
                        <button className={`ago-x ${chArmed ? "armed" : ""}`}
                          title={chArmed ? `Click again to delete #${c.name}` : "Delete channel"}
                          onClick={e => {
                            e.stopPropagation();
                            if (!chArmed) { arm(`chan:${c.id}`); return; }
                            disarm();
                            deleteChannel.mutate({ groupId: g.id, channelId: c.id });
                          }}>
                          {chArmed ? "Sure?" : <Icon name="x" />}
                        </button>
                      )}
                    </div>
                    {!threadsCollapsed && <div id={`ago-channel-threads-${c.id}`}>
                      {chThreads
                        .filter(t => !ui.unreadsOnly || (t.unread || 0) > 0)
                        .map(t => <SideThread key={t.root.id} t={t} g={g} c={c} />)}
                    </div>}
                  </div>
                );
              })}
              {open && !ui.unreadsOnly && admin && (
                creating?.kind === "channel" && creating.g === g.id
                  ? createRow
                  : <button className="ago-add" onClick={() => { setCreating({ kind: "channel", g: g.id }); setCreateName(""); }}>+ channel</button>
              )}
              {open && isDms && FEATURES.dms && <button className="ago-add" aria-label="Start a direct message with an agent" onClick={() => setDmOpen(true)}>+ agent</button>}
            </div>
          );
        })}
        {!orderedGroups.filter(g => !g.hidden).length && (
          <div className="dim" style={{ padding: "10px 12px", fontSize: 12 }}>
            No groups yet — create one to start chatting.
          </div>
        )}
      </div>
      {hiddenCount > 0 && (
        <div className="ago-hidden">
          <button className="ago-hidden-toggle" onClick={() => ui.toggleHiddenSection()}
            title={`${ui.hiddenOpen ? "Collapse" : "Expand"} hidden groups & channels`}>
            <span className={`ago-caret ${ui.hiddenOpen ? "open" : ""}`}><Icon name="chevron-right" /></span>
            <Icon name="eye-off" /> Hidden <span className="cnt">{hiddenCount}</span>
          </button>
          {ui.hiddenOpen && hiddenGroups.map(g => (
            <div key={g.id} className="ago-hidden-row" title={`Open ${g.name}`}
              onClick={() => ui.openGroupPage(g.id)}>
              <span className="nm">{g.name}</span>
              <button className="ago-x show" title={`Show ${g.name} in the sidebar`}
                onClick={e => { e.stopPropagation(); setGroupHidden.mutate({ groupId: g.id, hidden: false }); }}>
                <Icon name="eye" />
              </button>
            </div>
          ))}
          {ui.hiddenOpen && hiddenChans.map(({ g, c }) => (
            <div key={c.id} className="ago-hidden-row" title={`Open #${c.name}`}
              onClick={() => ui.selectChannel(g.id, c.id)}>
              <span className="nm"><span className="hash">#</span>{c.name}<span className="grp"> · {g.name}</span></span>
              <button className="ago-x show" title={`Show #${c.name} in the sidebar`}
                onClick={e => {
                  e.stopPropagation();
                  updateChannel.mutate({ groupId: g.id, channelId: c.id, hidden: false });
                }}>
                <Icon name="eye" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="ago-side-foot">
        {creating?.kind === "group"
          ? createRow
          : <button className="ago-add" onClick={() => { setCreating({ kind: "group" }); setCreateName(""); }}>+ New group</button>}
      </div>
      {dmOpen && <AgentDmPanel onClose={() => setDmOpen(false)} />}
    </div>
  );
}
