/* Thread side pane (.agora-thread) — the React port of agoDrawThread.
   <ThreadLog key={rootId}> remounts per thread: the mount effect snaps to
   the bottom (fresh open), while same-thread updates preserve the reader's
   place unless they're already at the bottom. */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flashMessage, useJump } from "../state/jump";
import {
  flattenMessages, useAgents, useChannelAgents, useGroups, useMarkThreadRead, useMe,
  useMessage, useMessages, usePinMessage, usePins, useThreads, type Message,
} from "@agora/core";
import { slugify } from "../lib/mentions";
import type { MentionCandidate } from "./Composer";
import { Icon } from "../lib/icons";
import { useUiState } from "../state/ui";
import { buildMentionIndex, type MentionIndex } from "../lib/mentions";
import { MessageItem } from "./MessageItem";
import { SectionRail } from "./SectionRail";
import { Composer } from "./Composer";
import { LiveRows } from "./ChannelPane";
import { LiveButton, LiveStrip, SpeakButton } from "./VoiceControls";

const AT_BOTTOM_PX = 40;
const NEAR_TOP_PX = 400;
const MAX_JUMP_PAGES = 10;

function ThreadLog({ root, replies, isAdmin, mentions, hasOlder, loadingOlder, pageCount, onLoadOlder }: {
  root: Message;
  replies: Message[];
  isAdmin: boolean;
  mentions?: MentionIndex;
  hasOlder: boolean;
  loadingOlder: boolean;
  pageCount: number;
  onLoadOlder: () => Promise<number>;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  // Track the oldest rendered reply while an older page is in flight; see
  // MessageLog for why this is an element anchor rather than a height delta.
  const anchorRef = useRef<{ mid: number; top: number; pages: number } | null>(null);

  // Jump-to-message (search/stars landing in this thread): flash it.
  const jumpTarget = useJump(s => s.target);
  const jumpClear = useJump(s => s.clear);

  /* The pane's jump effect drives its own paging and scrolls the target into
     view, so scroll-paging must stand down while a jump is in flight. */
  const loadOlder = () => {
    const box = boxRef.current;
    if (!box || anchorRef.current || jumpTarget?.container === "thread") return;
    if (!hasOlder || loadingOlder) return;
    const mid = replies[0]?.id;
    const anchor = mid == null
      ? null
      : box.querySelector<HTMLElement>(`[data-mid="${mid}"]`);
    if (!anchor) return;
    const pages = pageCount;
    anchorRef.current = { mid, top: anchor.offsetTop, pages };
    void onLoadOlder().then(
      nextPageCount => {
        // A growing page count is released by the layout effect after it has
        // restored the reader. Empty/deduped results have no render to do it.
        if (nextPageCount <= pages) anchorRef.current = null;
      },
      () => { anchorRef.current = null; },
    );
  };

  const onScroll = () => {
    const box = boxRef.current;
    if (!box) return;
    stickRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < AT_BOTTOM_PX;
    if (box.scrollTop < NEAR_TOP_PX) loadOlder();
  };

  // Absorb an older page without moving the reader; otherwise a fresh mount
  // (new thread) starts at the bottom and afterwards we only follow new
  // replies while the reader is already at the bottom.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const anchor = anchorRef.current;
    if (anchor && pageCount > anchor.pages) {
      anchorRef.current = null;
      const row = box.querySelector<HTMLElement>(`[data-mid="${anchor.mid}"]`);
      if (row) box.scrollTop += row.offsetTop - anchor.top;
      return;
    }
    if (stickRef.current) box.scrollTop = box.scrollHeight;
  }, [replies.length, pageCount]);

  const total = Math.max(root.reply_count ?? 0, replies.length);

  useEffect(() => {
    if (!jumpTarget || jumpTarget.container !== "thread" || !boxRef.current) return;
    if (flashMessage(boxRef.current, jumpTarget.mid)) {
      stickRef.current = false;
      jumpClear();
    }
  }, [jumpTarget, replies.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="ago-log-wrap">
      <div className="ago-log ago-thread-log" id="ago-thread-log" ref={boxRef}
        data-root={root.id} onScroll={onScroll}>
        <MessageItem message={root} inThread isAdmin={isAdmin} mentions={mentions}
          onOpenThread={() => {}} />
        {/* Prefer the server total while never falling behind loaded replies. */}
        <div className="ago-thread-sep">{total} repl{total === 1 ? "y" : "ies"}</div>
        <div className="ago-log-older" id="ago-thread-log-older" aria-live="polite">
          {hasOlder && (
            <button className="lnk" onClick={loadOlder} aria-busy={loadingOlder}>
              {loadingOlder ? "Loading earlier replies…" : "Load earlier replies"}
            </button>
          )}
        </div>
        {replies.map(m => (
          <MessageItem key={m.id} message={m} inThread isAdmin={isAdmin} mentions={mentions}
            onOpenThread={() => {}} />
        ))}
      </div>
      <SectionRail boxRef={boxRef} messages={[root, ...replies]} />
    </div>
  );
}

export function ThreadPane() {
  const ui = useUiState();
  const me = useMe().data;
  const groups = useGroups().data || [];
  const rootId = ui.threadRoot as number;
  const [toolsOpen, setToolsOpen] = useState(false);
  useEffect(() => setToolsOpen(false), [rootId]);
  const group = groups.find(g => g.id === ui.sel.g) || null;
  const channel = group?.channels?.find(c => c.id === ui.sel.c) || null;

  const q = useMessages(channel?.id || "", rootId);
  const replies = useMemo(() => flattenMessages(q.data), [q.data]);
  // Root fallback: outside the loaded top-level window (inbox, pin, link).
  const topQ = useMessages(channel?.id || "", null);
  const topLevel = useMemo(() => flattenMessages(topQ.data), [topQ.data]);
  const cachedRoot = topLevel.find(m => m.id === rootId);
  const fetchedRootQ = useMessage(rootId, !cachedRoot);
  const fetchedRoot = fetchedRootQ.data;
  const root = cachedRoot || fetchedRoot;
  const threadName = root?.alias?.trim() || "";

  const threads = useThreads().data || [];
  const threadRow = threads.find(t => t.root.id === rootId);
  const markRead = useMarkThreadRead(rootId);
  const pins = usePins(channel?.id || "").data || [];
  const pinMut = usePinMessage(channel?.id || "");
  const pinned = pins.some(p => p.id === rootId);

  const jumpTarget = useJump(s => s.target);
  const clearJump = useJump(s => s.clear);
  useEffect(() => {
    if (!jumpTarget || jumpTarget.container !== "thread") return;
    if (jumpTarget.mid === rootId || replies.some(m => m.id === jumpTarget.mid)) return;
    if (replies.length && replies[0].id <= jumpTarget.mid) clearJump();
    else if ((q.data?.pages.length || 0) >= MAX_JUMP_PAGES) clearJump();
    else if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
    else if (!q.hasNextPage && !q.isLoading) clearJump();
  }, [
    jumpTarget, replies.length, q.hasNextPage, q.isFetchingNextPage, q.isLoading,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  const agents = useChannelAgents(channel?.id || "").data || [];
  // Avatars come from the full /api/agents roster (the channel-agents payload
  // is {id, name} only) — same lookup as vanilla and MessageItem.
  const roster = useAgents().data || [];
  const isAdmin = !!(group && (group.role === "admin" || me?.instance_admin));
  const mentions = useMemo(
    () => buildMentionIndex(agents.map(a => ({ id: a.id, name: a.name })), me ? [me.username] : []),
    [agents, me],
  );
  const candidates = useMemo<MentionCandidate[]>(
    () => agents.map(a => ({
      type: "agent" as const, id: a.id, name: a.name, slug: slugify(a.name),
      avatar: roster.find(r => r.id === a.id)?.avatar || undefined,
    })),
    [agents, roster],
  );

  // Ack replies when the pane is open and the tab is focused.
  const unread = threadRow?.unread || 0;
  useLayoutEffect(() => {
    if (unread > 0 && document.visibilityState === "visible" && document.hasFocus()) {
      markRead.mutate(null);
    }
  }, [unread, rootId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!channel || (!root && !fetchedRootQ.isError)) {
    return <div className="agora-thread" id="agora-thread" style={{ display: "none" }}></div>;
  }
  if (!root || root.channel_id !== channel.id || root.thread_id != null) {
    return (
      <div className="agora-thread" id="agora-thread">
        <div className="ago-head">
          <div className="ago-head-text"><span className="ago-chan-name">Thread unavailable</span></div>
          <button className="btn sm ago-thread-close" onClick={() => ui.closeThread()}>
            <Icon name="x" />
          </button>
        </div>
        <div className="empty">This thread doesn't exist here, or you don't have access to it.</div>
      </div>
    );
  }

  return (
    <div className="agora-thread" id="agora-thread">
      <div className="ago-head">
        <button className="btn sm ago-back" title={`Back to #${channel.name}`}
          onClick={() => ui.closeThread()}>
          <Icon name="chevron-left" />
        </button>
        <div className="ago-head-text">
          <span className="ago-chan-name">Thread</span>
          <span className="dim ago-thread-chan" title={`Go to #${channel.name}`}
            onClick={() => ui.closeThread()}>
            <span className="hash">#</span>{channel.name}
          </span>
          {threadName && <span className="ago-thread-name" title={threadName}>{threadName}</span>}
        </div>
        {/* Docked to the side the header only has ~340px, so `.ago-btn-label`
            is hidden there and the titles carry the meaning; expanded (or
            full-width on a phone) the labels come back. */}
        <button className="btn sm ago-pane-tools-toggle" aria-label="Thread actions" aria-expanded={toolsOpen}
          onClick={() => setToolsOpen(!toolsOpen)}><Icon name="ellipsis" /></button>
        <div className={`ago-head-actions ago-thread-tools ${toolsOpen ? "open" : ""}`}>
          <button className={`btn sm ${ui.filesOpen && ui.filesThread === rootId ? "active" : ""}`}
            title="Files: attachments in this thread"
            onClick={() => ui.setFilesOpen(!(ui.filesOpen && ui.filesThread === rootId), rootId)}>
            <Icon name="paperclip" /><span className="ago-btn-label">Files</span>
          </button>
          {me?.voice_tts && <SpeakButton />}
          {me?.voice_stt && me?.voice_tts && <LiveButton channelId={channel.id} threadId={rootId} />}
          <button className={`btn sm ${pinned ? "active" : ""}`}
            title={pinned ? "Unpin this thread" : "Pin this thread for quick access"}
            onClick={() => pinMut.mutate({ messageId: rootId, pinned: !pinned })}>
            <Icon name="pin" cls={pinned ? "fill" : undefined} />
            <span className="ago-btn-label">{pinned ? "Pinned" : "Pin"}</span>
          </button>
          <button className="btn sm ago-thread-expand"
            title={ui.threadExpanded ? "Shrink thread back to the side panel" : "Expand thread to full width"}
            onClick={() => ui.toggleThreadSize()}>
            <Icon name={ui.threadExpanded ? "minimize-2" : "maximize-2"} />
          </button>
          <button className="btn sm ago-thread-close" onClick={() => ui.closeThread()}>
            <Icon name="x" />
          </button>
        </div>
      </div>
      <ThreadLog key={rootId} root={root} replies={replies} isAdmin={isAdmin} mentions={mentions}
        hasOlder={!!q.hasNextPage} loadingOlder={q.isFetchingNextPage}
        pageCount={q.data?.pages.length || 0}
        onLoadOlder={() => q.fetchNextPage().then(result => result.data?.pages.length || 0)} />
      <LiveRows channelId={channel.id} threadId={rootId} />
      <LiveStrip channelId={channel.id} threadId={rootId} />
      <Composer channelId={channel.id} channelName={channel.name} groupId={channel.group_id} threadId={rootId}
        agents={agents} candidates={candidates} voiceOK={!!me?.voice_stt}
        isDm={channel.kind === "agent_dm"} />
    </div>
  );
}
