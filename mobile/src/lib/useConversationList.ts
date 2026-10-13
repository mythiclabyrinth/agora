/* The scroll wiring a conversation's FlashList shares between the channel
   and thread screens: where it opens (useMessageLanding), staying pinned to
   the newest message (useFollowLatest), read acking (useReadAck), section
   rail jumps, and older-page loading. */

import { useCallback, useRef } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";

import { type SectionJumpList, useSectionJump } from "../components/SectionRail";
import { useFollowLatest } from "./followLatest";
import { isNearBottom, type ScrollMetrics, trackBottom, useReadAck } from "./readAck";
import { useBottomViewport } from "./useBottomViewport";
import { type LandingHistory, useMessageLanding } from "./useMessageLanding";

/* Chat layout: render anchored to the bottom and keep the viewport stable
   when older pages prepend at the top. FlashList's autoscrollToBottomThreshold
   is deliberately left unset: its "pin on the next data change" flag is
   sticky once armed (in 2.3.2 it's only re-evaluated while the threshold is
   set, but fires on any later change), so it could yank a landing or a
   reader who just started scrolling up down to the end. useFollowLatest is
   the one owner of bottom-pinning instead. Module-level so the prop keeps
   its identity across renders. */
const MAINTAIN_VISIBLE_CONTENT_POSITION = { startRenderingFromBottom: true } as const;

type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;

/** The FlashList ref methods a position re-read needs (all on FlashListRef). */
export interface MeasurableList {
  getAbsoluteLastScrollOffset(): number;
  getWindowSize(): { height: number };
  getFirstItemOffset(): number;
  getChildContainerDimensions(): { height: number };
}

/** The list's current position as an onScroll would report it, read from
    FlashList's own bookkeeping: no event fires when a jump is clamped at the
    end of the list. Its offset can be the unclamped target of the last
    scrollToIndex, so it's clamped to the real scroll range. Null when the
    list can't say yet (not laid out). */
export function listScrollMetrics(list: Partial<MeasurableList> | null): ScrollMetrics | null {
  if (
    !list?.getAbsoluteLastScrollOffset || !list.getWindowSize ||
    !list.getFirstItemOffset || !list.getChildContainerDimensions
  ) return null;
  try {
    const viewport = list.getWindowSize().height;
    const content = list.getFirstItemOffset() + list.getChildContainerDimensions().height;
    if (!(viewport > 0)) return null;
    const max = Math.max(0, content - viewport);
    const y = Math.min(Math.max(0, list.getAbsoluteLastScrollOffset()), max);
    return {
      contentOffset: { y },
      layoutMeasurement: { height: viewport },
      contentSize: { height: content },
    };
  } catch {
    // FlashList throws before its layout manager exists.
    return null;
  }
}

export function useConversationList({
  listRef,
  rows,
  latestId,
  target,
  landingNonce,
  oldestId,
  newestId = latestId > 0 ? latestId : null,
  separateTarget,
  history,
  dividerReady,
  dividerMessageId,
  lastReadId,
  ack,
  onNearBottom,
}: {
  listRef: {
    current:
      | (SectionJumpList & Partial<MeasurableList> & {
          scrollToEnd(options: { animated: boolean }): void;
        })
      | null;
  };
  rows: readonly unknown[];
  /** Newest message of the conversation (what a read ack marks). */
  latestId: number;
  target: number | null;
  /** Per-request token to land on the same target again (see useMessageLanding). */
  landingNonce?: string | null;
  oldestId: number | null;
  /** Newest message of the paged history; defaults to `latestId`. */
  newestId?: number | null;
  /** See useMessageLanding (a thread's root as the target). */
  separateTarget?: boolean;
  history: LandingHistory;
  dividerReady?: boolean;
  dividerMessageId?: number | null;
  lastReadId: () => number | undefined;
  ack: (id: number, onError: () => void) => void;
  /** Every scroll's "near the bottom" verdict (the channel's jump pill). */
  onNearBottom?: (near: boolean) => void;
}) {
  /* Not at the bottom until the landing says so (see useMessageLanding). */
  const atBottom = useRef(false);
  const {
    activeMessageId: activeSectionMessageId,
    onViewableItemsChanged,
    viewabilityConfig,
    jumpToSection,
    cancelSectionJump,
    isSectionJumping,
  } = useSectionJump({ listRef, rows, atBottom, latestId });

  /* Called only after this render (a landing settling), when everything it
     closes over below is initialized. */
  const rereadPosition = () => {
    const metrics = listScrollMetrics(listRef.current);
    if (metrics) onScrollMetrics(metrics);
    return metrics != null;
  };
  const reread = useRef(rereadPosition);
  reread.current = rereadPosition;

  const landing = useMessageLanding({
    target,
    nonce: landingNonce,
    rows,
    oldestId,
    newestId,
    separateTarget,
    history,
    dividerReady,
    dividerMessageId,
    atBottom,
    jumpTo: jumpToSection,
    cancelJump: cancelSectionJump,
    scrollToEnd: () => listRef.current?.scrollToEnd({ animated: false }),
    rereadPosition,
  });
  const onReachedBottom = useReadAck(latestId, lastReadId, ack, atBottom, landing.decided);
  const isBusy = () => landing.isLanding() || isSectionJumping();
  const follow = useFollowLatest(listRef, atBottom, isBusy);
  const onViewportLayout = useBottomViewport(listRef, atBottom, isBusy);

  const onScrollMetrics = (metrics: ScrollMetrics) => {
    // While a landing or section jump owns the position, scroll events can
    // be stale (the JS thread is busy rendering the destination): they must
    // not mark the viewer at the bottom, which acks, pins and snaps. Each
    // settled jump re-reads the real position.
    const near = isBusy() ? isNearBottom(metrics) : trackBottom(metrics, atBottom, onReachedBottom);
    follow.onScroll(metrics);
    onNearBottom?.(near);
  };
  const onScrollPosition = (e: ScrollEvent) => onScrollMetrics(e.nativeEvent);

  /** A dot tap supersedes an in-flight landing. */
  const onRailJump = useCallback((messageId: number) => {
    landing.cancelLanding();
    // Its scroll events were ignored while it moved; read where it ended.
    jumpToSection(messageId, { onSettled: () => reread.current() });
  }, [landing.cancelLanding, jumpToSection]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    highlightedId: landing.highlightedId,
    activeSectionMessageId,
    /** Everything programmatic stops: the landing (and its paging) and any
        section jump. For user actions that take the scroll position over. */
    cancelJumps: landing.cancelLanding,
    onRailJump,
    onViewportLayout,
    listProps: {
      maintainVisibleContentPosition: MAINTAIN_VISIBLE_CONTENT_POSITION,
      onLoad: landing.onListLoad,
      onStartReached: () => {
        if (history.hasNextPage && !history.isFetchingNextPage) history.fetchNextPage();
      },
      onStartReachedThreshold: 0.4,
      onScrollBeginDrag: () => {
        landing.cancelLanding();
        follow.onScrollBeginDrag();
      },
      // The throttle can drop the last onScroll of a gesture (Android), so
      // the resting position is read again when the scroll ends.
      onScrollEndDrag: (e: ScrollEvent) => {
        onScrollPosition(e);
        follow.onScrollEndDrag();
      },
      onMomentumScrollBegin: follow.onMomentumScrollBegin,
      onMomentumScrollEnd: (e: ScrollEvent) => {
        onScrollPosition(e);
        follow.onMomentumScrollEnd();
      },
      onContentSizeChange: follow.onContentSizeChange,
      onScroll: onScrollPosition,
      scrollEventThrottle: 64,
      onViewableItemsChanged,
      viewabilityConfig,
    },
  };
}
