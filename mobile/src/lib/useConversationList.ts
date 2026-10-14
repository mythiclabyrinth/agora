/* The scroll wiring a conversation's FlashList shares between the channel
   and thread screens: where it opens (useMessageLanding), staying pinned to
   the newest message (useFollowLatest), read acking (useReadAck), section
   rail jumps, and older-page loading. */

import { useCallback, useRef } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";

import { type SectionJumpList, useSectionJump } from "../components/SectionRail";
import { useFollowLatest } from "./followLatest";
import { type ScrollMetrics, trackBottom, useReadAck } from "./readAck";
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

/** How close to the start (in viewport heights) loads the older page. */
const START_REACHED_THRESHOLD = 0.4;

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
  newestId,
  separateTarget,
  separateTargetLoading,
  history,
  dividerReady,
  dividerMessageId,
  onOpeningDecided,
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
  /** Highest loaded id of the paged history (see newestLoadedId). */
  newestId: number | null;
  /** See useMessageLanding (a thread's root as the target). */
  separateTarget?: boolean;
  separateTargetLoading?: boolean;
  history: LandingHistory;
  dividerReady?: boolean;
  dividerMessageId?: number | null;
  /** See useMessageLanding. */
  onOpeningDecided?: () => void;
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
  /* FlashList fires onStartReached on entering the start threshold, not
     while the viewer stays inside it. A jump that ends there (a thread's
     root, the oldest loaded message) emits no scroll at all, and a page that
     lands while they stay there (rows inserted below an anchored first row,
     as under a thread's root) doesn't re-fire it either: the spinner above
     would stay until they scroll away and back. So both re-check here. */
  const loadOlderIfAtStart = (metrics: ScrollMetrics) => {
    if (
      metrics.contentOffset.y <= metrics.layoutMeasurement.height * START_REACHED_THRESHOLD &&
      history.hasNextPage && !history.isFetchingNextPage && !landing.isMerging() &&
      !history.failed && !history.paused
    ) history.fetchNextPage();
  };

  const rereadPosition = () => {
    follow.onProgrammaticScroll();
    const metrics = listScrollMetrics(listRef.current);
    if (metrics) {
      onScrollMetrics(metrics);
      loadOlderIfAtStart(metrics);
    }
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
    separateTargetLoading,
    history,
    dividerReady,
    dividerMessageId,
    onOpeningDecided,
    atBottom,
    // Called only after this render, like rereadPosition.
    jumpTo: (messageId, options) => {
      follow.onJumpAway();
      jumpToSection(messageId, options);
    },
    cancelJump: cancelSectionJump,
    scrollToEnd: () => {
      follow.onProgrammaticScroll();
      listRef.current?.scrollToEnd({ animated: false });
    },
    rereadPosition,
  });
  const onReachedBottom = useReadAck(latestId, lastReadId, ack, atBottom, landing.decided);
  const isBusy = () => landing.isLanding() || isSectionJumping();
  const follow = useFollowLatest(listRef, atBottom, isBusy);
  const onViewportLayout = useBottomViewport(listRef, atBottom, isBusy);

  const onScrollMetrics = (metrics: ScrollMetrics) => {
    // While a landing or section jump owns the position, scroll events can
    // be stale (the JS thread is busy rendering the destination): they must
    // not mark the viewer at the bottom, which acks, pins and snaps, nor
    // flip the jump pill. Each settled jump re-reads the real position.
    const near = isBusy() ? null : trackBottom(metrics, atBottom, onReachedBottom);
    follow.onScroll(metrics);
    if (near != null) onNearBottom?.(near);
  };
  const onScrollPosition = (e: ScrollEvent) => onScrollMetrics(e.nativeEvent);

  /** The jump pill's scroll follows: a fling it interrupts is over. */
  const cancelJumps = useCallback(() => {
    landing.cancelLanding();
    follow.onProgrammaticScroll();
  }, [landing.cancelLanding, follow.onProgrammaticScroll]); // eslint-disable-line react-hooks/exhaustive-deps

  /** A dot tap supersedes an in-flight landing. */
  const onRailJump = useCallback((messageId: number) => {
    landing.cancelLanding();
    follow.onJumpAway();
    // Its scroll events were ignored while it moved; read where it ended.
    jumpToSection(messageId, { onSettled: () => reread.current() });
  }, [landing.cancelLanding, jumpToSection, follow.onJumpAway]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    highlightedId: landing.highlightedId,
    activeSectionMessageId,
    /** Everything programmatic stops: the landing (and its paging) and any
        section jump. For user actions that take the scroll position over. */
    cancelJumps,
    onRailJump,
    onViewportLayout,
    listProps: {
      maintainVisibleContentPosition: MAINTAIN_VISIBLE_CONTENT_POSITION,
      onLoad: landing.onListLoad,
      onStartReached: () => {
        // Not while the landing merges the newest page: the older page's
        // result would be built from the pages before the merge.
        if (history.hasNextPage && !history.isFetchingNextPage && !landing.isMerging()) {
          history.fetchNextPage();
        }
      },
      onStartReachedThreshold: START_REACHED_THRESHOLD,
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
      onContentSizeChange: () => {
        follow.onContentSizeChange();
        // A landing pages on its own; only a settled list loads on here.
        if (isBusy()) return;
        const metrics = listScrollMetrics(listRef.current);
        if (metrics) loadOlderIfAtStart(metrics);
      },
      onScroll: onScrollPosition,
      scrollEventThrottle: 64,
      onViewableItemsChanged,
      viewabilityConfig,
    },
  };
}
