/* Threads inbox (.ago-inbox-list): every thread the user participates in,
   newest first, with rename and two-step remove on each row. */

import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  filterAndSortThreads, fmtTs, keys, useGroups, useHideThread, useMe, useRenameThread, useThreads,
  type ThreadFilter, type ThreadRow, type ThreadSort,
} from "@agora/core";
import { watchAnchoredOverlay } from "../lib/anchoredOverlay";
import { Icon } from "../lib/icons";
import { toast } from "../lib/toast";
import { useConfirm } from "../state/confirm";
import { useUiState } from "../state/ui";
import { PromptDialog } from "./PromptDialog";

function snippet(m: { alias?: string | null; text?: string }): string {
  const alias = (m.alias || "").trim();
  if (alias) return alias;
  return (m.text || "").split("\n")[0].slice(0, 140);
}

function relativeTime(ts: number): string {
  const seconds = Math.max(0, Date.now() / 1000 - ts);
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
  return new Date(ts * 1000).toLocaleDateString([], { month: "short", day: "numeric" });
}

function InboxRow({ t }: { t: ThreadRow }) {
  const ui = useUiState();
  const me = useMe().data;
  const groups = useGroups().data || [];
  const hide = useHideThread();
  const rename = useRenameThread();
  const armed = useConfirm(s => s.armed) === `thr:${t.root.id}`;
  const arm = useConfirm(s => s.arm);
  const disarm = useConfirm(s => s.disarm);
  const g = groups.find(x => x.id === t.group_id);
  const canRemove = (g && g.role === "admin") || !!me?.instance_admin;
  const root = t.root || ({} as ThreadRow["root"]);
  const [renaming, setRenaming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!menuOpen || !menuRef.current || !triggerRef.current) return;
    return watchAnchoredOverlay(triggerRef.current, menuRef.current, "center");
  }, [menuOpen]);

  return (
    <div className={`ago-inbox-row ${t.unread ? "unread" : ""}`}
      onClick={() => {
        ui.selectChannel(t.group_id, t.channel_id);
        ui.openThread(root.id, "replace");
      }}>
      <div className="ago-inbox-top">
        <div className="ago-inbox-meta">
          <time className="ts" title={fmtTs(t.last_reply_ts || root.ts)} dateTime={new Date((t.last_reply_ts || root.ts) * 1000).toISOString()}>{relativeTime(t.last_reply_ts || root.ts)}</time>
          <button ref={triggerRef} className="ago-inbox-more" aria-label="Thread options" aria-expanded={menuOpen}
            popoverTarget={menuId} onClick={e => e.stopPropagation()}><Icon name="ellipsis" /></button>
          <div id={menuId} ref={menuRef} popover="auto" className="ago-inbox-actions ago-inbox-menu"
            onToggle={e => setMenuOpen(e.newState === "open")} onClick={e => e.stopPropagation()}
            onKeyDown={e => { if (e.key === "Escape") { menuRef.current?.hidePopover(); triggerRef.current?.focus(); } }}>
            <button className="ago-x" title="Rename this thread"
              onClick={e => {
                e.stopPropagation();
                menuRef.current?.hidePopover();
                triggerRef.current?.focus();
                setRenaming(true);
              }}>
              <Icon name="pencil" /> Rename
            </button>
            {renaming && <PromptDialog title="Rename thread"
              description="Leave the name blank to use the first line of the thread."
              label="Thread name" value={root.alias || ""} pending={rename.isPending}
              onClose={() => setRenaming(false)} onSave={alias => rename.mutate(
                { threadId: root.id, alias },
                {
                  onSuccess: () => setRenaming(false),
                  onError: error => toast(`Couldn't rename thread: ${(error as Error).message}`, { variant: "warn" }),
                },
              )} />}
            {canRemove && (
              <button className={`ago-x ago-hide-btn ${armed ? "armed" : ""}`}
                title={armed ? "Click again to remove this thread" : "Remove from Threads (messages stay in the channel; posting again restores it)"}
                onClick={e => {
                  e.stopPropagation();
                  if (!armed) { arm(`thr:${root.id}`); return; }
                  disarm();
                  hide.mutate(root.id);
                }}>
                {armed ? "Confirm hide" : <><Icon name="x" /> Hide thread</>}
              </button>
            )}
          </div>
        </div>
      </div>
      <button className="ago-inbox-main" onClick={event => {
        event.stopPropagation();
        ui.selectChannel(t.group_id, t.channel_id);
        ui.openThread(root.id, "replace");
      }}>
        <span className="snippet">{snippet(root)}</span>
      </button>
      <div className="ago-inbox-foot">
        <span className="chan" title={`${t.group_name} / #${t.channel_name}`}>#{t.channel_name}</span>
        <span className="author">{root.author_name || root.author_id}</span>
        <span className="replies">{t.reply_count} repl{t.reply_count === 1 ? "y" : "ies"}</span>
        {(t.unread || 0) > 0 && <span className="ago-unread-badge">{t.unread > 99 ? "99+" : t.unread}</span>}
      </div>
    </div>
  );
}

export function ThreadsInbox() {
  const ui = useUiState();
  const qc = useQueryClient();
  const threads = useThreads().data || [];
  const sort = useUiState(state => state.threadsSort);
  const filter = useUiState(state => state.threadsFilter);
  const setSort = useUiState(state => state.setThreadsSort);
  const setFilter = useUiState(state => state.setThreadsFilter);
  const [search, setSearch] = useState("");
  const [toolsOpen, setToolsOpen] = useState(false);
  const displayedThreads = useMemo(
    () => filterAndSortThreads(threads, sort, filter).filter(t =>
      `${snippet(t.root)} ${t.channel_name} ${t.group_name} ${t.root.author_name || t.root.author_id}`.toLowerCase().includes(search.trim().toLowerCase())),
    [threads, sort, filter, search],
  );

  return (
    <div className="agora-main" id="agora-main">
      <div className="ago-head">
        <button className="btn sm ago-back" title="Back to groups" onClick={() => ui.backToGroups()}>
          <Icon name="chevron-left" />
        </button>
        <div className="ago-head-text">
          <span className="ago-chan-name"><Icon name="messages-square" /> Threads</span>
          <span className="dim">conversations you're part of</span>
        </div>
        <button className="btn sm ago-pane-tools-toggle" aria-label="Thread filters" aria-expanded={toolsOpen}
          onClick={() => setToolsOpen(!toolsOpen)}><Icon name="sliders" /></button>
        <div className={`ago-head-actions ago-inbox-tools ${toolsOpen ? "open" : ""}`}>
          <label className="ago-inbox-control">
            <span>Sort by</span>
            <select className="ago-search-scope" aria-label="Sort threads"
              value={sort} onChange={event => setSort(event.target.value as ThreadSort)}>
              <option value="recent">Recent</option>
              <option value="oldest">Oldest</option>
              <option value="az">A–Z</option>
              <option value="za">Z–A</option>
            </select>
          </label>
          <label className="ago-inbox-control">
            <span>Show</span>
            <select className="ago-search-scope" aria-label="Filter threads"
              value={filter} onChange={event => setFilter(event.target.value as ThreadFilter)}>
              <option value="all">All Threads</option>
              <option value="saved">Saved Threads</option>
              <option value="unset">Unset Threads</option>
            </select>
          </label>
          <button className="btn sm" title="Refresh"
            onClick={() => void qc.invalidateQueries({ queryKey: keys.threads })}>
            <Icon name="refresh-cw" />
          </button>
        </div>
      </div>
      <div className="ago-inbox-search"><Icon name="search" />
        <input type="search" aria-label="Search threads" placeholder="Find a conversation…"
          value={search} onChange={event => setSearch(event.target.value)} />
        <span>{displayedThreads.length} found</span>
      </div>
      <div className="ago-log ago-inbox-list">
        {displayedThreads.length
          ? displayedThreads.map(t => <InboxRow key={t.root.id} t={t} />)
          : (
            <div className="empty">
              <div className="glyph"><Icon name="messages-square" /></div>
              <div>{threads.length ? "No matching threads" : "No threads yet"}</div>
              <div className="hint">{threads.length
                ? "Try showing a different set of threads."
                : "Threads you start or reply in show up here, with unread counts as replies land."}</div>
            </div>
          )}
      </div>
    </div>
  );
}
