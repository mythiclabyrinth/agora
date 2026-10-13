/* Where a conversation opens: on a target message (deep link, search hit,
   inbox, notification), on the "New" divider, or at the newest message.
   Shared by the channel and thread screens.

   A target can sit hundreds of rows back, beyond the loaded pages. One
   landing is a single cancellable jump: older pages are fetched until the
   target row exists, then the section-jump controller lands it (re-resolving
   the index by id on every pass, so prepends can't skew it). A target that
   paging can't bring (newer than a stale cache, or a thread's root loading
   on its own) is awaited for a bounded time instead. Until the
   landing is decided the screen must not treat the viewer as "at the
   bottom": that would ack messages they never saw and let follow-latest
   pin the list back down mid-jump. */

import { useCallback, useEffect, useRef, useState } from "react";

import { messageRowIndex, type SectionJumpOptions } from "../components/SectionRail";

/** Older pages one landing may fetch, counted from where it started (#189):
    pages already cached by scroll-paging don't use up the budget. */
export const MAX_LANDING_PAGES = 10;
export const LANDING_HIGHLIGHT_MS = 3000;
/** Center a target; show a few read messages above the divider. */
export const TARGET_VIEW_POSITION = 0.5;
export const DIVIDER_VIEW_POSITION = 0.2;
/** How long one landing waits for a target that isn't loaded but may still
    arrive (see landingStep's "await") before falling back. */
export const AWAIT_TARGET_MS = 8000;

/** A route's message id param as a landing target: only a positive integer
    is one. Anything else (`/m/abc`, an empty or partial id) opens the
    conversation as if there were no target, rather than paging for a
    message that can't exist. Deliberately stricter than @agora/core's
    notificationMessageId, which also accepts payload forms like "1e3" or
    " 7" that a route param must not. */
export function parseMessageId(param: string | string[] | undefined): number | null {
  if (typeof param !== "string" || !/^\d+$/.test(param)) return null;
  const id = Number(param);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** "wait" is for an older page in flight; "await" for a target that paging
    can't bring but that may still arrive (bounded by AWAIT_TARGET_MS). */
export type LandingStep = "land" | "fetch" | "wait" | "await" | "giveUp";

/** One paging decision for a target that isn't necessarily loaded yet. */
export function landingStep({
  found,
  target,
  oldestId,
  newestId,
  pagesFetched,
  hasNextPage,
  fetching,
  failed,
  refreshing = false,
  separate = false,
  waitedOut = false,
}: {
  found: boolean;
  target: number;
  oldestId: number | null;
  newestId: number | null;
  pagesFetched: number;
  hasNextPage: boolean;
  fetching: boolean;
  failed: boolean;
  /** The newest page is being refetched. */
  refreshing?: boolean;
  /** The target's row loads apart from the paged history (a thread's root). */
  separate?: boolean;
  /** This landing has awaited its target for AWAIT_TARGET_MS already. */
  waitedOut?: boolean;
}): LandingStep {
  if (found) return "land";
  if (!waitedOut) {
    if (separate) return "await";
    // Newer than anything loaded: the cache predates it (the usual
    // notification tap, for a message that arrived while backgrounded). The
    // foreground refetch or the socket brings it; paging never would.
    if (newestId == null || target > newestId || refreshing) return "await";
  }
  if (separate) return "giveUp";
  // Loaded history already reaches past the target: it's gone (deleted, or
  // it belongs to another conversation).
  if (oldestId != null && oldestId <= target) return "giveUp";
  // In flight first: TanStack keeps isFetchNextPageError set while a retry of
  // the failed page is running, and that retry may still bring the target.
  if (fetching) return "wait";
  if (failed || pagesFetched >= MAX_LANDING_PAGES) return "giveUp";
  return hasNextPage ? "fetch" : "giveUp";
}

export interface LandingHistory {
  /** The first page has arrived. */
  loaded: boolean;
  pageCount: number;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  /** The last older-page fetch failed; stop paging rather than spin. */
  failed: boolean;
  /** The newest page is being refetched (foreground, invalidation): a target
      missing from a stale cache is awaited until it's back. */
  refreshing?: boolean;
  fetchNextPage: () => void;
}

export function useMessageLanding({
  target,
  nonce = null,
  rows,
  oldestId,
  newestId,
  separateTarget = false,
  history,
  dividerReady = true,
  dividerMessageId = null,
  atBottom,
  jumpTo,
  cancelJump,
  scrollToEnd,
  rereadPosition,
}: {
  target: number | null;
  /** Changes per request to land on `target` again (a repeated notification
      tap for the same message). Entry points without one land once. */
  nonce?: string | null;
  rows: readonly unknown[];
  /** Oldest loaded message of the paged history (not a thread's root). */
  oldestId: number | null;
  /** Newest loaded message of the paged history. */
  newestId: number | null;
  /** The target's row loads apart from the paged history (a thread's root
      targeted): it's awaited, never paged for. */
  separateTarget?: boolean;
  history: LandingHistory;
  /** Whether the divider position is known (the channel's read marker). */
  dividerReady?: boolean;
  /** First unread message right under the "New" divider, if one is shown. */
  dividerMessageId?: number | null;
  atBottom: { current: boolean };
  jumpTo: (messageId: number, options?: SectionJumpOptions) => void;
  cancelJump: () => void;
  scrollToEnd: () => void;
  /** Re-reads the list's real scroll position into atBottom/follow-latest.
      A jump clamped at the end of the list emits no scroll event, so without
      this a landing on the newest message would leave the viewer "not at the
      bottom" (no read ack, a stale jump pill) until they scroll. Returns
      false when the list couldn't be measured. */
  rereadPosition?: () => boolean;
}) {
  const [listReady, setListReady] = useState(false);
  // Read acking waits on this: false while any landing (the opening one, or
  // a later one in place) still owns the viewport, which is transient.
  const [decided, setDecided] = useState(false);
  const [highlightedId, setHighlightedId] = useState<number | null>(null);
  // Bumped when an awaited target runs out of time, to decide again.
  const [awaitExpiries, setAwaitExpiries] = useState(0);
  const run = useRef({
    target: null as number | null, nonce: null as string | null, base: 0, requested: -1, paging: false, settleUntil: 0,
    /** When awaiting the target stops (0: not awaiting yet). */
    awaitUntil: 0,
    /** The opening landing gave up and falls back once the divider is known. */
    fallback: false,
    /** The screen's opening landing, which may fall back to the divider. */
    initial: true,
    /** atBottom before an in-place landing, restored if it finds nothing. */
    wasAtBottom: false,
  });
  const initialDone = useRef(false);
  const decidedRef = useRef(false);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const awaitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopAwaiting = useCallback(() => {
    if (awaitTimer.current) clearTimeout(awaitTimer.current);
    awaitTimer.current = null;
  }, []);
  useEffect(() => () => {
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    stopAwaiting();
  }, [stopAwaiting]);

  const decide = useCallback(() => {
    initialDone.current = true;
    decidedRef.current = true;
    setDecided(true);
  }, []);
  const undecide = useCallback(() => {
    decidedRef.current = false;
    setDecided(false);
  }, []);

  const latest = useRef({ rows, dividerMessageId, scrollToEnd, jumpTo, rereadPosition });
  latest.current = { rows, dividerMessageId, scrollToEnd, jumpTo, rereadPosition };

  /** A landing's jump has settled: ack/follow from where the list really is.
      decide() comes first so the re-read sees the landing as over; the read
      ack's enabled effect then schedules if this left the viewer at the
      bottom. Returns whether the position could be re-read. */
  const settle = useCallback(() => {
    decide();
    return latest.current.rereadPosition?.() ?? false;
  }, [decide]);

  /** Divider if it's on screen, otherwise the newest message. */
  const landWithoutTarget = useCallback((afterPaging: boolean) => {
    const { rows: current, dividerMessageId: dividerId } = latest.current;
    if (dividerId != null && messageRowIndex(current, dividerId) >= 0) {
      initialDone.current = true;
      latest.current.jumpTo(dividerId, {
        viewPosition: DIVIDER_VIEW_POSITION,
        animated: false,
        onSettled: settle,
      });
    } else {
      // Paging kept the viewport anchored, but FlashList may have drifted
      // while rows prepended; settle on the newest message explicitly.
      if (afterPaging) latest.current.scrollToEnd();
      atBottom.current = true;
      decide();
    }
  }, [atBottom, decide, settle]);

  useEffect(() => {
    if (!listReady || !history.loaded) return;
    const r = run.current;
    if (target != null && (r.target !== target || r.nonce !== nonce)) {
      cancelJump();
      stopAwaiting();
      run.current = {
        target, nonce, base: history.pageCount, requested: -1, paging: true, settleUntil: 0,
        awaitUntil: 0, fallback: false, initial: !initialDone.current, wasAtBottom: atBottom.current,
      };
      // Before any paging: nothing may pin to (or ack) the bottom now.
      atBottom.current = false;
      undecide();
    }
    // A refetch can swap the pages out from under a fresh landing (returning
    // to the foreground refetches just the newest page, dropping rows the
    // socket had appended), so a target that vanishes while the jump is
    // still settling is paged back in and landed again. The jump in flight
    // is stopped first, so its settling can't decide the landing mid-paging.
    if (
      target != null && !run.current.paging && Date.now() < run.current.settleUntil &&
      messageRowIndex(rows, target) < 0
    ) {
      cancelJump();
      run.current = { ...run.current, base: history.pageCount, requested: -1, paging: true, awaitUntil: 0 };
      undecide();
    }
    if (target != null && run.current.paging) {
      const requested = run.current.requested === history.pageCount;
      const step = landingStep({
        found: messageRowIndex(rows, target) >= 0,
        target,
        oldestId,
        newestId,
        pagesFetched: history.pageCount - run.current.base,
        hasNextPage: history.hasNextPage,
        // Only a fetch actually in flight is waited on: one TanStack
        // cancelled (a refetch or invalidation) never adds its page, so the
        // same page is asked for again (fetchNextPage dedupes).
        fetching: history.isFetchingNextPage,
        failed: history.failed && requested,
        refreshing: history.refreshing,
        separate: separateTarget,
        waitedOut: run.current.awaitUntil > 0 && Date.now() >= run.current.awaitUntil,
      });
      if (step !== "await") stopAwaiting();
      if (step === "await") {
        // Bounded: decided again when the time is up, if nothing else changed.
        // The deadline is per run, but the timer is re-armed whenever a
        // fetch/wait step in between cleared it — otherwise nothing would
        // wake the landing at the deadline.
        if (run.current.awaitUntil === 0) run.current.awaitUntil = Date.now() + AWAIT_TARGET_MS;
        if (awaitTimer.current == null) {
          awaitTimer.current = setTimeout(() => {
            awaitTimer.current = null;
            setAwaitExpiries((n) => n + 1);
          }, Math.max(0, run.current.awaitUntil - Date.now()));
        }
      } else if (step === "fetch") {
        run.current.requested = history.pageCount;
        history.fetchNextPage();
      } else if (step === "land") {
        run.current.paging = false;
        run.current.settleUntil = Date.now() + LANDING_HIGHLIGHT_MS;
        initialDone.current = true;
        // Decided once the jump has settled, not when it starts: with the JS
        // thread busy rendering the destination, scroll events still report
        // the old bottom position for a while, and that must not read as the
        // viewer reaching the bottom.
        jumpTo(target, { viewPosition: TARGET_VIEW_POSITION, animated: false, onSettled: settle });
        setHighlightedId(target);
        if (highlightTimer.current) clearTimeout(highlightTimer.current);
        highlightTimer.current = setTimeout(() => setHighlightedId(null), LANDING_HIGHLIGHT_MS);
      } else if (step === "giveUp") {
        run.current.paging = false;
        if (run.current.initial) {
          // Opening: the divider, once the read marker says where it is.
          run.current.fallback = true;
        } else {
          // In place (a notification tapped while reading): the viewer is
          // already somewhere they chose; a target that can't be found must
          // not move them. Older pages prepended under MVCP's anchoring, so
          // the viewport, and whether it's at the bottom, is unchanged: the
          // re-read reports that, and the position from before stands in
          // when the list can't be measured.
          if (!settle()) atBottom.current = run.current.wasAtBottom;
        }
      }
    }
    if (target != null && run.current.fallback) {
      if (dividerReady) {
        run.current.fallback = false;
        landWithoutTarget(true);
      }
      return;
    }
    if (target == null && !initialDone.current && dividerReady) landWithoutTarget(false);
  }, [
    listReady, target, nonce, rows, oldestId, newestId, separateTarget, dividerReady, history.loaded,
    history.pageCount, history.hasNextPage, history.isFetchingNextPage, history.failed,
    history.refreshing, awaitExpiries,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  /** A user action takes over (a drag, a rail tap, the jump pill): stop
      paging and any correction passes, and let acks and follow-latest run
      again. The scroll that action starts reports the new position. */
  const cancelLanding = useCallback(() => {
    run.current.paging = false;
    run.current.settleUntil = 0;
    run.current.fallback = false;
    stopAwaiting();
    cancelJump();
    decide();
  }, [cancelJump, decide, stopAwaiting]);

  const onListLoad = useCallback(() => setListReady(true), []);
  const isLanding = useCallback(() => run.current.paging || !decidedRef.current, []);

  return { decided, highlightedId, onListLoad, cancelLanding, isLanding };
}
