/* Read-acking shared by the channel and thread screens. The newest message is
   acked when it lands while the viewer sits at the bottom, or when the viewer
   scrolls down to it later. Debounced like the desktop's PUT /read. */

import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";

const ACK_DELAY_MS = 600;
/** A failed ack is retried once after this, if the viewer is still at the
    bottom; returning to the foreground retries too. */
export const ACK_RETRY_MS = 3000;

/** Whether `latestId` should be acked: there is a message, and it's newer
    than the viewer's read marker. An unknown marker (not in the cache yet)
    acks — the server keeps the max, so a redundant ack is safe. */
export function needsReadAck(latestId: number, lastReadId: number | undefined): boolean {
  if (latestId <= 0) return false;
  return lastReadId === undefined || latestId > lastReadId;
}

/** How close (px) to the end of the list still counts as "at the bottom". */
export const BOTTOM_SLOP = 60;

export type ScrollMetrics = {
  contentOffset: { y: number };
  layoutMeasurement: { height: number };
  contentSize: { height: number };
};

/** Whether a scroll position is within BOTTOM_SLOP of the end. */
export function isNearBottom(e: ScrollMetrics): boolean {
  return e.contentOffset.y + e.layoutMeasurement.height >= e.contentSize.height - BOTTOM_SLOP;
}

/** onScroll glue: updates `atBottom` and fires `onReachedBottom` when the
    list crosses into the bottom. Returns whether it's at the bottom now. The
    order matters — the transition is read before the ref is overwritten. */
export function trackBottom(
  e: ScrollMetrics,
  atBottom: { current: boolean },
  onReachedBottom: () => void,
): boolean {
  const near = isNearBottom(e);
  const crossed = near && !atBottom.current;
  atBottom.current = near;
  if (crossed) onReachedBottom();
  return near;
}

/** Wires both ack triggers. `lastReadId` is read at schedule time so callers
    can pull it from the query cache; `ack` must call `onError` if the request
    fails so it can be retried. `enabled` holds every ack back while the
    screen is still deciding where it opens (see useMessageLanding). Returns
    the callback to run when the list scrolls back to the bottom. */
export function useReadAck(
  latestId: number,
  lastReadId: () => number | undefined,
  ack: (id: number, onError: () => void) => void,
  atBottom: { current: boolean },
  enabled = true,
): () => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retried = useRef(0);
  // The ack's onError can run after the screen has gone (or been reused for
  // another conversation); nothing may be retried from then on.
  const mounted = useRef(true);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  // The cached marker only moves on the server's WS echo; remembering what we
  // already sent stops a scroll up-and-down from re-acking the same id.
  const sent = useRef(0);
  // Refs keep the returned callback stable while still seeing fresh values —
  // mutation `mutate` identities change across renders.
  const latest = useRef({ latestId, lastReadId, ack });
  latest.current = { latestId, lastReadId, ack };

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const schedule = useCallback(() => {
    cancel();
    if (!mounted.current || !enabledRef.current) return;
    const { latestId: id, lastReadId: readId } = latest.current;
    if (id === sent.current || !needsReadAck(id, readId())) return;
    // The once-per-id retry guard is per id: another id being acked starts
    // over, so this one failing again later still gets its retry.
    if (retried.current !== id) retried.current = 0;
    // Decided now, not when the timer fires: a message landing shifts the
    // list and briefly reads as "not at the bottom", which would drop live
    // acks.
    timer.current = setTimeout(() => {
      timer.current = null;
      sent.current = id;
      latest.current.ack(id, () => {
        if (sent.current === id) sent.current = 0;
        if (!mounted.current) return;
        // Once per id, so a server that keeps refusing isn't hammered.
        if (retried.current === id) return;
        retried.current = id;
        if (retry.current) clearTimeout(retry.current);
        retry.current = setTimeout(() => {
          retry.current = null;
          if (atBottom.current) schedule();
        }, ACK_RETRY_MS);
      });
    }, ACK_DELAY_MS);
  }, [cancel, atBottom]);

  // A new latest id supersedes any pending ack, as does unmounting — that's
  // also what keeps an id from being acked against a conversation the screen
  // was reused for. Enabling re-checks too: the "newest messages" landing
  // acks what the viewer sees on open.
  useEffect(() => {
    // Set here too: on a remount (StrictMode, Fast Refresh) this effect runs
    // before the AppState one below that also sets it.
    mounted.current = true;
    if (atBottom.current) schedule();
    return cancel;
  }, [latestId, enabled, atBottom, schedule, cancel]);

  // An ack that failed (offline, suspended mid-request) gets another chance
  // when the app comes back, without waiting for a scroll.
  useEffect(() => {
    mounted.current = true;
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && atBottom.current) schedule();
    });
    return () => {
      mounted.current = false;
      sub.remove();
      if (retry.current) clearTimeout(retry.current);
      retry.current = null;
    };
  }, [atBottom, schedule]);

  return schedule;
}
