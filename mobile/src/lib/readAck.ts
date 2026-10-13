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

/** Wires both ack triggers. `lastReadId` is read at schedule time so callers
    can pull it from the query cache; returns the callback to run when the
    list scrolls back to the bottom. */
export function useReadAck(
  latestId: number,
  lastReadId: () => number | undefined,
  ack: (id: number) => void,
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
    const { latestId: id, lastReadId: readId, ack: send } = latest.current;
    if (id === sent.current || !needsReadAck(id, readId())) return;
    // `send` is bound now: a screen reused for another conversation must not
    // ack this id against the new one's marker.
    timer.current = setTimeout(() => {
      timer.current = null;
      sent.current = id;
      send(id);
    }, ACK_DELAY_MS);
  }, [cancel]);

  // A new latest id supersedes any pending ack, as does unmounting.
  useEffect(() => {
    if (atBottom.current) schedule();
    return cancel;
  }, [latestId, atBottom, schedule, cancel]);

  return schedule;
}
