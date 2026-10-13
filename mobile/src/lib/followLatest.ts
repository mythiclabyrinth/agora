/* Keeping the newest message pinned while the viewer follows a live
   conversation. This is the only thing that scrolls a conversation to its
   end on new content: FlashList's own autoscroll-to-bottom is left off (see
   useConversationList).

   An append doesn't move the scroll offset, so on Android a row that then
   measures taller than its estimate (wrapped text, a chart, an image) leaves
   the viewer short of the bottom for a moment and `atBottom` reads false.
   `atBottom` can't tell that transient shift from the reader scrolling away,
   so "following" is tracked separately: it starts when the viewer is at the
   bottom, survives content growing under them, and ends when they (or a
   programmatic scroll) move the offset away from the end. */

import { useCallback, useEffect, useRef } from "react";

import { BOTTOM_SLOP, type ScrollMetrics } from "./readAck";

export function shouldPinToEnd({
  following,
  interacting,
  busy,
}: {
  following: boolean;
  /** A finger (or the fling it started) is moving the list. */
  interacting: boolean;
  /** A message landing or section jump owns the scroll position. */
  busy: boolean;
}): boolean {
  return following && !interacting && !busy;
}

/** Whether the offset moved up from where the viewer last sat at the end by
    more than the bottom slop, beyond what a shrinking scroll range (content
    getting shorter, or the viewport taller) would clamp it by. Appends only
    grow the content, so they never count as moving away. */
export function movedAwayFromEnd(from: ScrollMetrics, to: ScrollMetrics): boolean {
  const range = (m: ScrollMetrics) => m.contentSize.height - m.layoutMeasurement.height;
  const rise = from.contentOffset.y - to.contentOffset.y;
  const clamped = Math.max(0, range(from) - range(to));
  return rise - clamped > BOTTOM_SLOP;
}

/** `atBottom` is the screen's ref, kept current by trackBottom before every
    `onScroll` call here; it doubles as the "near the end" verdict. */
export function useFollowLatest(
  list: { current: { scrollToEnd: (options: { animated: boolean }) => void } | null },
  atBottom: { current: boolean },
  isBusy: () => boolean,
) {
  const following = useRef(false);
  const interacting = useRef(false);
  // The last scroll position seen at the end: the baseline for movedAwayFromEnd.
  const atEnd = useRef<ScrollMetrics | null>(null);
  const frame = useRef<number | null>(null);
  const busy = useRef(isBusy);
  busy.current = isBusy;
  useEffect(() => () => {
    if (frame.current != null) cancelAnimationFrame(frame.current);
  }, []);

  const onScroll = useCallback((e: ScrollMetrics) => {
    if (atBottom.current) {
      following.current = true;
      atEnd.current = {
        contentOffset: { y: e.contentOffset.y },
        layoutMeasurement: { height: e.layoutMeasurement.height },
        contentSize: { height: e.contentSize.height },
      };
      return;
    }
    // A drag or a jump moving away ends following. So does any upward move
    // nothing in the layout explains, with or without a gesture: iOS's
    // status-bar tap scrolls to the top without drag or momentum events.
    if (
      interacting.current || busy.current() ||
      (atEnd.current != null && movedAwayFromEnd(atEnd.current, e))
    ) following.current = false;
  }, [atBottom]);
  const onInteractionStart = useCallback(() => {
    interacting.current = true;
  }, []);
  const onInteractionEnd = useCallback(() => {
    interacting.current = false;
    following.current = atBottom.current;
  }, [atBottom]);
  const onContentSizeChange = useCallback(() => {
    // A landing that settles on the newest message marks the viewer at the
    // bottom without any scroll event: that starts following too.
    if (atBottom.current) following.current = true;
    if (!shouldPinToEnd({
      following: following.current,
      interacting: interacting.current,
      busy: busy.current(),
    })) return;
    if (frame.current != null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      // A landing, rail jump or drag can start in the same frame; it owns the
      // scroll from then on.
      if (!shouldPinToEnd({
        following: following.current,
        interacting: interacting.current,
        busy: busy.current(),
      })) return;
      list.current?.scrollToEnd({ animated: false });
    });
  }, [list, atBottom]);

  return {
    onScroll,
    onScrollBeginDrag: onInteractionStart,
    onScrollEndDrag: onInteractionEnd,
    onMomentumScrollBegin: onInteractionStart,
    onMomentumScrollEnd: onInteractionEnd,
    onContentSizeChange,
  };
}
