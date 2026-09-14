/* The channel message log (.ago-log#ago-log): stick-to-bottom scrolling,
   the "New" divider landed on when entering a channel with unreads, the
   jump-to-latest bar, and visible+focused+at-bottom mark-read. */

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  flattenMessages, useGroups, useMarkRead, useMessages, type Message,
} from "@agora/core";
import { Icon } from "../lib/icons";
import { type MentionIndex } from "../lib/mentions";
import { flashMessage, useJump } from "../state/jump";
import { MessageItem } from "./MessageItem";
import { SectionRail } from "./SectionRail";

const AT_BOTTOM_PX = 48;
const NEAR_TOP_PX = 400;
const MAX_JUMP_PAGES = 10;

export function MessageLog({ channelId, isAdmin, mentions, onOpenThread }: {
  channelId: string;
  isAdmin: boolean;
  mentions?: MentionIndex;
  onOpenThread: (rootId: number) => void;
}) {
  const groups = useGroups().data || [];
  const q = useMessages(channelId, null);
  const markRead = useMarkRead(channelId);
  const messages = useMemo(() => flattenMessages(q.data), [q.data]);
  const jumpTarget = useJump(s => s.target);
  const jumpClear = useJump(s => s.clear);

  const boxRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);           // was the user at the bottom pre-render?
  const landOnDividerRef = useRef(false);
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Pre-fetch scroll metrics for the older page in flight, so the prepended
  // rows can be absorbed without moving the reader. Non-null also means "a
  // page is already on its way", which keeps scroll events from stacking.
  const anchorRef = useRef<{ h: number; t: number; pages: number } | null>(null);

  const channel = groups.flatMap(g => g.channels || []).find(c => c.id === channelId);
  const unread = channel?.unread || 0;

  /* Divider position is captured once per channel entry (like
     _agoDividerChan): after the last-read id at the moment of entry. */
  const dividerAfterRef = useRef<number | null>(null);
  const dividerChanRef = useRef<string | null>(null);
  if (dividerChanRef.current !== channelId) {
    dividerChanRef.current = channelId;
    dividerAfterRef.current = unread > 0 ? (channel?.last_read_id || 0) : null;
    landOnDividerRef.current = dividerAfterRef.current != null;
    stickRef.current = true;
    anchorRef.current = null;  // never restore one channel's offset into another
  }

  const maybeMarkRead = () => {
    const box = boxRef.current;
    if (!box || document.visibilityState !== "visible" || !document.hasFocus()) return;
    if (box.scrollHeight - box.scrollTop - box.clientHeight >= AT_BOTTOM_PX) return;
    if (!unread && !messages.length) return;
    if (readTimer.current) clearTimeout(readTimer.current);
    readTimer.current = setTimeout(() => {
      if (unread > 0) markRead.mutate(null);
    }, 400);
  };

  /* Page one screen further back. The jump effect below drives its own paging
     and scrolls the target into view, so the two must not run at once. */
  const loadOlder = () => {
    const box = boxRef.current;
    if (!box || anchorRef.current || jumpTarget?.container === "log") return;
    if (!q.hasNextPage || q.isFetchingNextPage) return;
    const pages = q.data?.pages.length || 0;
    anchorRef.current = { h: box.scrollHeight, t: box.scrollTop, pages };
    void q.fetchNextPage().then(
      result => {
        // A growing page count is released by the layout effect after it has
        // restored the reader. Empty/deduped results have no render to do it.
        if ((result.data?.pages.length || 0) <= pages) anchorRef.current = null;
      },
      () => { anchorRef.current = null; },
    );
  };

  const onScroll = () => {
    const box = boxRef.current;
    if (!box) return;
    stickRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < AT_BOTTOM_PX;
    if (stickRef.current) maybeMarkRead();
    if (box.scrollTop < NEAR_TOP_PX) loadOlder();
  };

  // Older page absorbed, initial land, then follow new messages while stuck to
  // the bottom. Restoring by height *delta* rather than the saved offset keeps
  // the reader's place no matter how tall the prepended rows turned out.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const anchor = anchorRef.current;
    if (anchor && (q.data?.pages.length || 0) > anchor.pages) {
      anchorRef.current = null;
      box.scrollTop = box.scrollHeight - anchor.h + anchor.t;
      return;
    }
    if (landOnDividerRef.current && dividerRef.current) {
      landOnDividerRef.current = false;
      stickRef.current = false;
      box.scrollTop = Math.max(0, dividerRef.current.offsetTop - 8);
    } else if (stickRef.current) {
      box.scrollTop = box.scrollHeight;
    }
  }, [messages.length, channelId, q.data?.pages.length]);

  useEffect(() => { maybeMarkRead(); });

  /* Jump-to-message (search/stars): flash it when rendered; page older
     history in until it appears (newest-first pages, so "next" = older). */
  useEffect(() => {
    if (!jumpTarget || jumpTarget.container !== "log" || !boxRef.current) return;
    if (flashMessage(boxRef.current, jumpTarget.mid)) {
      stickRef.current = false;
      jumpClear();
    } else if (messages.length && messages[0].id <= jumpTarget.mid) {
      // IDs are globally monotonic. Once the oldest loaded row is below the
      // target, another older page cannot contain an absent target.
      jumpClear();
    } else if ((q.data?.pages.length || 0) >= MAX_JUMP_PAGES) {
      jumpClear();
    } else if (q.hasNextPage && !q.isFetchingNextPage) {
      void q.fetchNextPage();
    } else if (!q.hasNextPage) {
      jumpClear(); // scrolled the whole history without finding it
    }
  }, [jumpTarget, messages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "visible") maybeMarkRead(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  });

  const jumpToLatest = () => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
    stickRef.current = true;
    maybeMarkRead();
  };

  let dividerPlaced = false;
  const rows: React.ReactNode[] = [];
  for (const m of messages as Message[]) {
    if (!dividerPlaced && dividerAfterRef.current != null && m.id > dividerAfterRef.current) {
      rows.push(
        <div key="divider" className="ago-new-divider" id="ago-new-divider" ref={dividerRef}>
          <span>New</span>
        </div>,
      );
      dividerPlaced = true;
    }
    rows.push(
      <MessageItem key={m.id} message={m} inThread={false} isAdmin={isAdmin}
        mentions={mentions} onOpenThread={onOpenThread} />,
    );
  }

  return (
    <>
      {unread > 0 && (
        <div className="ago-unread-bar" id="ago-unread-bar">
          <span className="ago-unread-n">{unread} new message{unread === 1 ? "" : "s"}</span>
          <button className="lnk" onClick={jumpToLatest}>Jump to latest <Icon name="arrow-down" /></button>
          <button className="lnk dim" onClick={() => markRead.mutate(null)}>Mark as read</button>
        </div>
      )}
      <div className="ago-log-wrap">
        <div className="ago-log" id="ago-log" ref={boxRef} onScroll={onScroll}>
          {/* Mounted whenever older history exists, not just mid-fetch: toggling
              it per fetch changes the content height right as the reader scrolls
              up, which reads as a jump. The button is the keyboard-reachable
              path to what scrolling does on its own. */}
          <div className="ago-log-older" id="ago-log-older" aria-live="polite">
            {q.hasNextPage && (
              q.isFetchingNextPage ? (
                <span>Loading earlier messages…</span>
              ) : (
                <button className="lnk" onClick={loadOlder}>Load earlier messages</button>
              )
            )}
          </div>
          {rows.length ? rows : (
            <div className="empty">
              <div className="glyph"><Icon name="message-circle" /></div>
              <div>No messages yet</div>
              <div className="hint">Say something — member agents will answer here. Use the Members button to invite an agent.</div>
            </div>
          )}
        </div>
        <SectionRail boxRef={boxRef} messages={messages as Message[]} />
      </div>
    </>
  );
}
