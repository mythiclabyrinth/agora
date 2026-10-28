import { useState } from "react";
import {
  doneBadgeList, filterSchedules, type ScheduleFilter, lostChannelAccess, scheduleGroupName, scheduleTruncatedNote, sortSchedulesByTime, useAllDoneSchedules,
  useAllSchedules, useGroups, type Schedule,
} from "@agora/core";
import { useUiState } from "../state/ui";
import { ScheduleEmpty, ScheduleFilters, ScheduleRow } from "./SchedulesPane";

/** Every schedule in channels the caller can access (admins: all channels;
    DMs stay owner-only), as one time-ordered list; each card names its
    channel (and thread). */
export function SchedulesInbox() {
  const q = useAllSchedules();
  const ui = useUiState();
  const groups = useGroups().data || [];
  const [filter, pickFilter] = useState<ScheduleFilter>("all");
  // When Done was last selected, for its badge (doneBadgeList).
  const [doneOpenedAt, setDoneOpenedAt] = useState<number | null>(null);
  const setFilter = (next: ScheduleFilter) => { setDoneOpenedAt(next === "done" ? Date.now() : null); pickFilter(next); };
  const showDone = filter === "done";
  const doneQ = useAllDoneSchedules(showDone);
  const shown = showDone ? doneQ : q;
  const allItems = sortSchedulesByTime((q.data?.items || []).filter(s => s.status !== "cancelled"));
  const items = showDone ? sortSchedulesByTime(doneQ.data?.items || []) : filterSchedules(allItems, filter);
  const open = (s: Schedule) => {
    // Agent DMs carry group_id "" — selectChannel maps that to the DMs group.
    if (s.group_id == null) return;
    // The owner was removed from that channel: it can't be opened.
    if (lostChannelAccess(s)) return;
    ui.selectChannel(s.group_id, s.channel_id);
    if (s.thread_id != null) ui.openThread(s.thread_id);
  };
  return (
    <div className="ago-inbox-content ago-sched-inbox">
      <ScheduleFilters items={allItems} done={doneBadgeList(doneQ, showDone ? doneOpenedAt : null)}
        value={filter} onChange={setFilter} />
      <div className="ago-log">
        {shown.isLoading && <div className="empty">Loading schedules…</div>}
        {shown.isError && <div className="empty">Couldn't load schedules. <button className="btn sm" onClick={() => void shown.refetch()}>Retry</button></div>}
        {!shown.isLoading && !shown.isError && !items.length && <ScheduleEmpty filter={filter} />}
        {items.map(s => (
          <ScheduleRow key={s.id} schedule={s} groupName={scheduleGroupName(s, groups)}
            onOpen={lostChannelAccess(s) ? undefined : open} />
        ))}
        {shown.data?.truncated && <div className="ago-sched-truncated" role="status">{scheduleTruncatedNote(filter)}</div>}
      </div>
    </div>
  );
}
