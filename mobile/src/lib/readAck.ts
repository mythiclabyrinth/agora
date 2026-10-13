/* Read-acking shared by the channel and thread screens. The newest message is
   acked when it lands while the viewer sits at the bottom, or when the viewer
   scrolls down to it later. Debounced like the desktop's PUT /read. */

import { useCallback, useEffect, useRef } from "react";

const ACK_DELAY_MS = 600;

/** Whether `latestId` should be acked: there is a message, and it's newer
    than the viewer's read marker. An unknown marker (not in the cache yet)
    acks — the server keeps the max, so a redundant ack is safe. */
export function needsReadAck(latestId: number, lastReadId: number | undefined): boolean {
  if (latestId <= 0) return false;
  return lastReadId === undefined || latestId > lastReadId;
}

/** How close (px) to the end of the list still counts as "at the bottom". */
export const BOTTOM_SLOP = 60;

type ScrollMetrics = {
  contentOffset: { y: number };
  layoutMeasurement: { height: number };
  contentSize: { height: number };
};

/** onScroll glue: updates `atBottom` and fires `onReachedBottom` when the
    list crosses into the bottom. Returns whether it's at the bottom now. The
    order matters — the transition is read before the ref is overwritten. */
export function trackBottom(
  e: ScrollMetrics,
  atBottom: { current: boolean },
  onReachedBottom: () => void,
): boolean {
  const near =
    e.contentOffset.y + e.layoutMeasurement.height >= e.contentSize.height - BOTTOM_SLOP;
  const crossed = near && !atBottom.current;
  atBottom.current = near;
  if (crossed) onReachedBottom();
  return near;
}

/** Wires both ack triggers. `lastReadId` is read at schedule time so callers
    can pull it from the query cache; `ack` must call `onError` if the request
    fails so a later scroll can retry. Returns the callback to run when the
    list scrolls back to the bottom. */
export function useReadAck(
  latestId: number,
  lastReadId: () => number | undefined,
  ack: (id: number, onError: () => void) => void,
  atBottom: { current: boolean },
): () => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    const { latestId: id, lastReadId: readId } = latest.current;
    if (id === sent.current || !needsReadAck(id, readId())) return;
    // Decided now, not when the timer fires: a message landing shifts the
    // list and briefly reads as "not at the bottom", which would drop live
    // acks.
    timer.current = setTimeout(() => {
      timer.current = null;
      sent.current = id;
      latest.current.ack(id, () => {
        if (sent.current === id) sent.current = 0;
      });
    }, ACK_DELAY_MS);
  }, [cancel]);

  // A new latest id supersedes any pending ack, as does unmounting — that's
  // also what keeps an id from being acked against a conversation the screen
  // was reused for.
  useEffect(() => {
    if (atBottom.current) schedule();
    return cancel;
  }, [latestId, atBottom, schedule, cancel]);

  return schedule;
}
