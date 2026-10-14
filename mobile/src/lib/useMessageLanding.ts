/* Where a conversation opens: on a target message (deep link, search hit,
   inbox, notification), on the "New" divider, or at the newest message.
   Shared by the channel and thread screens.

   A target can sit hundreds of rows back, beyond the loaded pages. One
   landing is a single cancellable jump: older pages are fetched until the
   target row exists, then the section-jump controller lands it (re-resolving
   the index by id on every pass, so prepends can't skew it). A target that
   paging can't bring (newer than a stale cache, or a thread's root loading
   on its own) is waited for only while a request that may bring it is in
   flight. Until the landing is decided the screen must not treat the
   viewer as "at the bottom": that would ack messages they never saw and let
   follow-latest pin the list back down mid-jump. */

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  appendMessage, flattenMessages, keys, MESSAGE_PAGE_SIZE, useApi,
  type ApiClient, type Message, type MessagePages,
} from "@agora/core";

import { messageRowIndex, type SectionJumpOptions } from "../components/SectionRail";

/** Older pages one landing may fetch, counted from where it started (#189):
    pages already cached by scroll-paging don't use up the budget. */
export const MAX_LANDING_PAGES = 10;
export const LANDING_HIGHLIGHT_MS = 3000;
/** Center a target; show a few read messages above the divider. */
export const TARGET_VIEW_POSITION = 0.5;
export const DIVIDER_VIEW_POSITION = 0.2;

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

/** The newest id among the loaded messages: what bounds the ids a refetch of
    the newest page could still bring. Not the last row's id: history is
    ordered (and paged) by `seq ?? id`, and a queued message's seq is bumped
    to the newest position when an agent picks it up, so the last row can be
    an old id. The oldest bound stays the first row's id, not the lowest: a
    bumped row's low id says nothing about what's older, while every message
    an older page holds got its seq (sent or bumped) before the first row was
    sent, so has a lower id, unless that first row is itself a bumped one. */
export function newestLoadedId(messages: readonly { id: number }[]): number | null {
  let newest: number | null = null;
  for (const m of messages) if (newest == null || m.id > newest) newest = m.id;
  return newest;
}

/** "wait" is for a request in flight that may bring the target; "refetch"
    asks for the newest page once. */
export type LandingStep = "land" | "fetch" | "wait" | "refetch" | "giveUp";

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
  paused = false,
  refreshing = false,
  refreshed = false,
  separate = false,
}: {
  found: boolean;
  target: number;
  oldestId: number | null;
  newestId: number | null;
  pagesFetched: number;
  hasNextPage: boolean;
  fetching: boolean;
  failed: boolean;
  /** The query is paused (offline): an older page won't arrive until the
      network does, so paging for the target stops rather than holding the
      screen (and its acks) indefinitely. */
  paused?: boolean;
  /** A request that may bring the target is in flight: the newest page's
      refetch, or a separate target's own fetch. */
  refreshing?: boolean;
  /** The newest page has been refetched during this landing already. */
  refreshed?: boolean;
  /** The target's row loads apart from the paged history (a thread's root). */
  separate?: boolean;
}): LandingStep {
  if (found) return "land";
  if (refreshing) return "wait";
  if (separate) return "giveUp";
  // An older page in flight first: it may bring the target, and a newest-page
  // merge written meanwhile would be overwritten by that fetch's result
  // (built from the pages as they were when it started). TanStack also keeps
  // isFetchNextPageError set while a retry of a failed page runs.
  if (fetching) return "wait";
  // Newer than anything loaded: the cache predates it (the usual
  // notification tap, for a message that arrived while backgrounded).
  // Paging never brings it; the newest page, refetched once, may.
  if (newestId == null || target > newestId) return refreshed ? "giveUp" : "refetch";
  // Inside the loaded range but missing: deleted, another conversation's, or
  // a hole the cache picked up while the socket was down (a live message
  // appended after it). The newest page, once, fills a hole up to a page
  // wide; a wider one waits for the reconnect's refetch.
  if (oldestId != null && oldestId <= target) return refreshed ? "giveUp" : "refetch";
  if (failed || paused || pagesFetched >= MAX_LANDING_PAGES) return "giveUp";
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
      missing from a stale cache is waited for until it's back. */
  refreshing?: boolean;
  /** The query is paused (offline): a refetch won't run until the network
      is back, so the landing doesn't wait on its own. */
  paused?: boolean;
  fetchNextPage: () => void;
  /** Fetches the newest page once and merges it into the cache
      (useMergeNewestPage); settles when that request does. */
  refetch: () => Promise<unknown>;
}

/** A landing's newest-page request isn't the query's, so nothing else bounds
    it: past this it counts as failed and the landing falls back. */
export const NEWEST_PAGE_TIMEOUT_MS = 10_000;

/** Fetches a conversation's newest page once and merges the messages the
    cache lacks into it, the way live socket messages are (appendMessage):
    a landing on a message newer than the cache needs only that page. Not a
    refetch of the infinite query: that re-requests every cached page, one
    after another, and trimming it first would drop the shared cache's
    older pages from under any other screen (or viewer) reading them. The
    cache's pages and pageParams stay as they are, so @agora/core's
    page-length bookkeeping (#189), and so hasNextPage, is untouched. */
export async function mergeNewestPage(
  api: Pick<ApiClient, "get">,
  qc: QueryClient,
  channelId: string,
  threadId: number | null,
): Promise<void> {
  const params = new URLSearchParams({ limit: String(MESSAGE_PAGE_SIZE) });
  if (threadId != null) params.set("thread_id", String(threadId));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = { current: false, rebuilding: false };
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      late.current = true;
      // A rebuild still running is cancelled; TanStack then restores the
      // pages as they were, rather than swapping them under the viewer later.
      if (late.rebuilding) {
        void qc.cancelQueries({ queryKey: keys.messages(channelId, threadId), exact: true });
      }
      reject(new Error("newest page timed out"));
    }, NEWEST_PAGE_TIMEOUT_MS);
  });
  // Everything below, the gap path's refetch included, is bounded by one
  // deadline; past it the landing falls back, and a response that turns up
  // later changes nothing under a viewer who has moved on.
  try {
    await Promise.race([mergeOrRebuild(api, qc, channelId, threadId, params, late), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function mergeOrRebuild(
  api: Pick<ApiClient, "get">,
  qc: QueryClient,
  channelId: string,
  threadId: number | null,
  params: URLSearchParams,
  late: { current: boolean; rebuilding: boolean },
): Promise<void> {
  const r = await api.get<{ messages: Message[] }>(`/api/channels/${channelId}/messages?${params}`);
  if (late.current) return;
  const key = keys.messages(channelId, threadId);
  const cached = new Set(flattenMessages(qc.getQueryData<MessagePages>(key)).map((m) => m.id));
  // A full page that shares nothing with the cache means more arrived than
  // one page holds: merging would leave a silent hole between the two. A
  // full refetch rebuilds every cached page contiguously from the newest
  // one, without dropping pages other screens on this key are showing.
  if (
    cached.size > 0
    && r.messages.length >= MESSAGE_PAGE_SIZE
    && !r.messages.some((m) => cached.has(m.id))
  ) {
    late.rebuilding = true;
    await qc.refetchQueries({ queryKey: key, exact: true });
    return;
  }
  const fresh = r.messages.filter((m) => !cached.has(m.id));
  if (fresh.length === 0) return;
  qc.setQueryData<MessagePages>(key, (data) =>
    fresh.reduce<MessagePages | undefined>(appendMessage, data));
}

/** mergeNewestPage bound to a conversation: a landing's `history.refetch`. */
export function useMergeNewestPage(channelId: string, threadId: number | null) {
  const api = useApi();
  const qc = useQueryClient();
  return useCallback(
    () => mergeNewestPage(api, qc, channelId, threadId),
    [api, qc, channelId, threadId],
  );
}

/** A thread root targeted by a landing could still arrive: its own fetch is
    in flight, or the top-level history that may hold it (cachedRoot) is
    still loading. Pending but not fetching (paused offline) brings nothing
    soon, so isn't waited on. */
export function threadRootLoading(
  fetchedRoot: { isFetching: boolean },
  topLevel: { isPending: boolean; isFetching: boolean },
): boolean {
  return fetchedRoot.isFetching || (topLevel.isPending && topLevel.isFetching);
}

export function useMessageLanding({
  target,
  nonce = null,
  rows,
  oldestId,
  newestId,
  separateTarget = false,
  separateTargetLoading = false,
  history,
  dividerReady = true,
  dividerMessageId = null,
  onOpeningDecided,
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
  /** First row of the paged history (not a thread's root). */
  oldestId: number | null;
  /** Highest loaded id of the paged history (newestLoadedId), not the last
      row's. */
  newestId: number | null;
  /** The target's row loads apart from the paged history (a thread's root
      targeted): it's waited for while its own fetch runs, never paged for. */
  separateTarget?: boolean;
  /** The separate target could still arrive: its own fetch, or whatever
      may supply it, is in flight (see threadRootLoading). */
  separateTargetLoading?: boolean;
  history: LandingHistory;
  /** Whether the divider position is known (the channel's read marker), or
      can't be any time soon: the opening landing waits on it. */
  dividerReady?: boolean;
  /** First unread message right under the "New" divider, if one is shown. */
  dividerMessageId?: number | null;
  /** The opening landing has decided: its jump settled (or it opened at the
      newest message), so acks can start. Once per screen; not called when
      the user took over (a drag, a rail or pill tap) first. */
  onOpeningDecided?: () => void;
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
  // Bumped when a landing's own refetch settles, to decide again.
  const [refetchesSettled, setRefetchesSettled] = useState(0);
  /** Newest-page merges still in flight, across runs: a newer landing
      (another tap) doesn't end an earlier one's request. */
  const mergesInFlight = useRef(0);
  const run = useRef({
    target: null as number | null, nonce: null as string | null, base: 0, requested: -1, paging: false, settleUntil: 0,
    /** The newest page was refetched during this run (its own or another). */
    refreshed: false,
    /** This run's own refetch is in flight. */
    refetching: false,
    /** This run's own refetch has settled (or timed out): from then on a
        query refetch it set off (the gap path) isn't waited on. */
    mergeSettled: false,
    /** The opening landing gave up and falls back once the divider is known. */
    fallback: false,
    /** The screen's opening landing, which may fall back to the divider. */
    initial: true,
    /** atBottom before an in-place landing, restored if it finds nothing. */
    wasAtBottom: false,
  });
  /** The opening is over: committed to a position, or the user took over. */
  const initialDone = useRef(false);
  /** onOpeningDecided is still due: not yet decided, and no user takeover. */
  const openingReportDue = useRef(true);
  const onOpeningDecidedRef = useRef(onOpeningDecided);
  onOpeningDecidedRef.current = onOpeningDecided;
  const decidedRef = useRef(false);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
  }, []);

  const decide = useCallback(() => {
    initialDone.current = true;
    decidedRef.current = true;
    setDecided(true);
    // Not from a user takeover: cancelLanding clears it first.
    if (openingReportDue.current) {
      openingReportDue.current = false;
      onOpeningDecidedRef.current?.();
    }
  }, []);
  const undecide = useCallback(() => {
    decidedRef.current = false;
    setDecided(false);
  }, []);

  const latest = useRef({ target, nonce, rows, dividerMessageId, scrollToEnd, jumpTo, rereadPosition });
  latest.current = { target, nonce, rows, dividerMessageId, scrollToEnd, jumpTo, rereadPosition };

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
    // FlashList doesn't finish a first layout (so no onLoad) while it has no
    // rows: an empty conversation would never decide, leaving acks and
    // pinning off until a first message arrived. Open it at the bottom; a
    // target can't be in an empty history, and whatever arrives later is
    // landed on in place.
    if (
      !listReady && history.loaded && rows.length === 0 &&
      !initialDone.current && dividerReady
    ) {
      // That target is handled: a first live message mounting the list later
      // mustn't start an in-place landing (and pause acks) for it. A thread
      // root loads apart from the history, so it's still landed on.
      if (target != null && !separateTarget) {
        Object.assign(run.current, { target, nonce, paging: false });
      }
      landWithoutTarget(false);
      return;
    }
    if (!listReady || !history.loaded) return;
    const r = run.current;
    if (target != null && (r.target !== target || r.nonce !== nonce)) {
      cancelJump();
      run.current = {
        target, nonce, base: history.pageCount, requested: -1, paging: true, settleUntil: 0,
        refreshed: false, refetching: false, mergeSettled: false, fallback: false, initial: !initialDone.current,
        wasAtBottom: atBottom.current,
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
    // Still the same run: it doesn't get another refetch of its own. Nor a
    // fallback: the viewer has already been shown the target, so if it's
    // gone for good (deleted) they stay where they are.
    if (
      target != null && !run.current.paging && Date.now() < run.current.settleUntil &&
      messageRowIndex(rows, target) < 0
    ) {
      cancelJump();
      // A refetch that dropped it is waited on again (mergeSettled cleared):
      // that's what may bring it back.
      Object.assign(run.current, {
        base: history.pageCount, requested: -1, paging: true, initial: false, mergeSettled: false,
      });
      undecide();
    }
    if (target != null && run.current.paging) {
      const current = run.current;
      // Anything that resets the query (a reset or removal elsewhere) can
      // shrink the history below where this run started counting.
      if (history.pageCount < current.base) current.base = history.pageCount;
      const requested = current.requested === history.pageCount;
      if (history.refreshing) current.refreshed = true;
      const step = landingStep({
        found: messageRowIndex(rows, target) >= 0,
        target,
        oldestId,
        newestId,
        pagesFetched: history.pageCount - current.base,
        hasNextPage: history.hasNextPage,
        // Only a fetch actually in flight is waited on: one TanStack
        // cancelled (a refetch or invalidation) never adds its page, so the
        // same page is asked for again (fetchNextPage dedupes).
        fetching: history.isFetchingNextPage,
        failed: history.failed && requested,
        paused: history.paused,
        // Its own refetch is waited on only while it can run: paused
        // (offline) it would hold the landing, and the acks, indefinitely,
        // so it counts as settled without the target.
        refreshing: separateTarget
          ? separateTargetLoading
          : (history.refreshing && !current.mergeSettled) ||
            ((current.refetching || mergesInFlight.current > 0) && !history.paused),
        refreshed: current.refreshed,
        separate: separateTarget,
      });
      if (step === "fetch") {
        current.requested = history.pageCount;
        history.fetchNextPage();
      } else if (step === "refetch") {
        current.refreshed = true;
        const settled = () => {
          current.refetching = false;
          current.mergeSettled = true;
          setRefetchesSettled((n) => n + 1);
        };
        if (history.paused) {
          // Offline it wouldn't get through: settle without a request.
          settled();
        } else {
          // Waited on through its own promise: the request isn't the
          // query's, so the screen never reports it as refreshing.
          current.refetching = true;
          mergesInFlight.current += 1;
          const done = () => {
            mergesInFlight.current -= 1;
            settled();
          };
          void history.refetch().then(done, done);
        }
      } else if (step === "land") {
        current.paging = false;
        current.settleUntil = Date.now() + LANDING_HIGHLIGHT_MS;
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
        current.paging = false;
        if (current.initial) {
          // Opening: the divider, once the read marker says where it is.
          current.fallback = true;
        } else {
          // In place (a notification tapped while reading): the viewer is
          // already somewhere they chose; a target that can't be found must
          // not move them. Older pages prepended under MVCP's anchoring, so
          // the viewport, and whether it's at the bottom, is unchanged: the
          // re-read reports that, and the position from before stands in
          // when the list can't be measured.
          if (!settle()) atBottom.current = current.wasAtBottom;
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
    listReady, target, nonce, rows, oldestId, newestId, separateTarget, separateTargetLoading,
    dividerReady, history.loaded, history.pageCount, history.hasNextPage,
    history.isFetchingNextPage, history.failed, history.refreshing, history.paused, refetchesSettled,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  /** A user action takes over (a drag, a rail tap, the jump pill): stop
      paging and any correction passes, and let acks and follow-latest run
      again. The scroll that action starts reports the new position. */
  const cancelLanding = useCallback(() => {
    // The highlight is left to fade on its own timer: the landed row is
    // still on screen when the user takes over.
    // A target whose run hasn't started yet (history or the list still
    // loading) is taken over too: starting it later would yank the viewer
    // mid-gesture. Only a new target or nonce lands again.
    const { target: current, nonce: currentNonce } = latest.current;
    if (current != null) Object.assign(run.current, { target: current, nonce: currentNonce });
    run.current.paging = false;
    run.current.settleUntil = 0;
    run.current.fallback = false;
    cancelJump();
    // A takeover isn't the opening deciding: a divider can still come.
    openingReportDue.current = false;
    decide();
  }, [cancelJump, decide]);

  const onListLoad = useCallback(() => setListReady(true), []);
  const isLanding = useCallback(() => run.current.paging || !decidedRef.current, []);
  /** The landing's own newest-page merge is in flight: an older-page fetch
      started now would overwrite it with the pages as they were (TanStack
      builds its result from the cache at fetch start). */
  const isMerging = useCallback(() => mergesInFlight.current > 0, []);

  return { decided, highlightedId, onListLoad, cancelLanding, isLanding, isMerging };
}
