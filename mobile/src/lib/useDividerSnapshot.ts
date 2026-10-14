/* The channel screen's "New" divider marker, snapshotted once per screen. */

import { useCallback, useRef } from "react";
import type { FetchStatus } from "@tanstack/react-query";

/** The channel's read marker (0 when nothing is unread) as soon as its
    metadata is there. Until then the opening position waits for the groups
    payload, but only while its first attempt is in flight. Once that attempt
    has failed (TanStack would retry with backoff), or the query is paused
    offline or idle, nothing is coming soon, so the opening doesn't wait.
    Frozen at 0 (no divider) once the opening landing has decided: from then
    on the messages a late payload would mark unread may have been read and
    acked from this very screen. A user taking over before that doesn't
    freeze it. */
export function useDividerSnapshot(
  channel: { unread?: number; last_read_id?: number } | null | undefined,
  /** The groups query. */
  groups: { isPending: boolean; fetchStatus: FetchStatus; failureCount: number },
) {
  const after = useRef<number | null>(null);
  if (after.current === null && channel) {
    after.current = (channel.unread ?? 0) > 0 ? (channel.last_read_id ?? 0) : 0;
  }
  const onOpeningDecided = useCallback(() => { after.current ??= 0; }, []);
  return {
    marker: after.current ?? 0,
    dividerReady: after.current !== null || !groups.isPending || groups.fetchStatus !== "fetching" ||
      groups.failureCount > 0,
    onOpeningDecided,
  };
}
