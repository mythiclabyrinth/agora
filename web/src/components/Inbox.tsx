import { useEffect, useState } from "react";
import { filterUnreads, fmtRelative, formatUnreadCount, useMarkUnreadsRead, useUnreads, type UnreadFilter, type UnreadItem } from "@agora/core";
import { Icon } from "../lib/icons";
import { useJump } from "../state/jump";
import { useUiState, writeHistory } from "../state/ui";
import { ThreadsInbox } from "./ThreadsInbox";

function initialTab(): "unreads" | "threads" | null {
  if (window.location.pathname === "/inbox/threads") return "threads";
  if (window.location.pathname === "/inbox/unreads") return "unreads";
  return null;
}

export function Inbox() {
  const unreads = useUnreads();
  const markRead = useMarkUnreadsRead();
  const ui = useUiState();
  const requestJump = useJump(s => s.request);
  const [selectedTab, setSelectedTab] = useState<"unreads" | "threads" | null>(initialTab);
  const [filter, setFilter] = useState<UnreadFilter>("all");
  const tab = selectedTab ?? (unreads.isLoading || (!unreads.isError && (unreads.data?.length ?? 0) > 0) ? "unreads" : "threads");
  const displayedItems = filterUnreads(unreads.data ?? [], filter);
  const limited = unreads.total > (unreads.data?.length ?? 0);
  const unreadTotal = unreads.data?.reduce((sum, item) => sum + item.unread, 0) ?? 0;
  const showTabCount = !limited && !unreads.data?.some(item => item.unread >= 100);
  useEffect(() => {
    const onPop = () => setSelectedTab(initialTab());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => { setSelectedTab(initialTab()); }, [ui.view]);
  useEffect(() => {
    if (selectedTab === null && !unreads.isLoading) {
      setSelectedTab(!unreads.isError && (unreads.data?.length ?? 0) > 0 ? "unreads" : "threads");
    }
  }, [selectedTab, unreads.isLoading, unreads.isError, unreads.data]);
  const switchTab = (next: "unreads" | "threads") => {
    writeHistory(`/inbox/${next}`, "replace");
    setSelectedTab(next);
  };
  const open = (item: UnreadItem) => {
    ui.selectChannel(item.group_id, item.channel_id);
    if (item.thread_id != null) ui.openThread(item.thread_id);
    requestJump({ mid: item.first_unread_id, container: item.thread_id == null ? "log" : "thread" });
  };
  return <div className="agora-main ago-inbox-shell" id="agora-main">
    <header className="ago-inbox-nav">
      <button className="btn sm ago-back" title="Back to groups" aria-label="Back to groups"
        onClick={() => ui.backToGroups()}><Icon name="chevron-left" /></button>
      <nav className="ago-inbox-tabs" role="tablist" aria-label="Inbox tabs">
        <button role="tab" aria-selected={tab === "unreads"} onClick={() => switchTab("unreads")}>Unreads {showTabCount && unreadTotal ? `(${unreadTotal})` : ""}</button>
        <button role="tab" aria-selected={tab === "threads"} onClick={() => switchTab("threads")}>Threads</button>
      </nav>
    </header>
    {tab === "threads" ? <ThreadsInbox embedded /> : <div className="ago-inbox-content ago-unreads">
      <div className="ago-unreads-toolbar">
        <div className="ago-unreads-filters" aria-label="Filter unreads">
          {(["all", "mentions", "channels", "threads"] as const).map(option =>
            <button key={option} aria-pressed={filter === option} onClick={() => setFilter(option)}>
              {option === "mentions" ? "@Mentions" : option[0].toUpperCase() + option.slice(1)}
            </button>)}
        </div>
        {limited && <span className="dim">Showing {unreads.data?.length ?? 0} of {unreads.total}</span>}
        {!!displayedItems.length && <button className="btn sm" disabled={markRead.isPending}
          onClick={() => markRead.mutate(displayedItems)}>{limited ? "Mark shown read" : filter === "all" ? "Mark all read" : "Mark these read"}</button>}
      </div>
      <div className="ago-log ago-unreads-list">
        {unreads.isLoading ? <div className="empty">Loading unreads…</div> : unreads.isError ?
          <div className="empty">Couldn't load unreads. <button className="btn sm" onClick={() => void unreads.refetch()}>Retry</button></div> :
          displayedItems.map(item =>
            <div className="ago-unread-card" key={`${item.kind}:${item.thread_id ?? item.channel_id}`}>
              <button className="ago-unread-source" onClick={() => open(item)}>
                {item.kind === "thread" ? `↳ ${item.title || "Thread"} in ` : ""}#{item.channel_name} · {item.group_name}
              </button>
              <div className="ago-unread-actions">
                <span className="ago-unread-meta"><time>{fmtRelative(item.latest_ts)}</time>
                  <span className="ago-unread-badge">{formatUnreadCount(item.unread)}</span>
                  {item.mentions > 0 && <span className="ago-unread-badge mention">@ {item.mentions}</span>}
                </span>
                <button className="ago-unread-mark" aria-label={`Mark ${item.kind} read`} title="Mark read" disabled={markRead.isPending}
                  onClick={() => markRead.mutate([item])}><Icon name="check" /></button>
              </div>
              <button className="ago-unread-preview" onClick={() => open(item)}>{item.previews.map(message =>
                <span key={message.id}><strong>{message.author_name || message.author_id}:</strong>{" "}
                  {message.text.replace(/\s+/g, " ").trim() || "Attachment"}
                </span>)}</button>
            </div>)}
        {!unreads.isLoading && !unreads.isError && displayedItems.length === 0 &&
          <div className="empty"><div className="glyph"><Icon name="check" /></div><div>You're all caught up</div></div>}
      </div>
    </div>}
  </div>;
}
