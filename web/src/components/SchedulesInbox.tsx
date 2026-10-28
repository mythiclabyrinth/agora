import { useState } from "react";
import {
  doneBadgeList, filterSchedules, type ScheduleFilter, lostChannelAccess, scheduleChannelLabel, scheduleGroupName, scheduleTruncatedNote, sortSchedules, useAllDoneSchedules,
  useAllSchedules, useGroups, type Schedule,
} from "@agora/core";
import { Icon } from "../lib/icons";
import { useUiState } from "../state/ui";
import { ScheduleEmpty, ScheduleFilters, ScheduleRow } from "./SchedulesPane";

/** Every schedule in channels the caller can access (admins: all channels;
    DMs stay owner-only), grouped by channel. */
export function SchedulesInbox() {
  const q = useAllSchedules();
  const ui = useUiState();
  const groups = useGroups().data || [];
  const groupName = (id: string | null) => groups.find(g => g.id === id)?.name ?? "";
  const [filter, pickFilter] = useState<ScheduleFilter>("all");
  // When Done was last selected, for its badge (doneBadgeList).
  const [doneOpenedAt, setDoneOpenedAt] = useState<number | null>(null);
  const setFilter = (next: ScheduleFilter) => { setDoneOpenedAt(next === "done" ? Date.now() : null); pickFilter(next); };
  const showDone = filter === "done";
  const doneQ = useAllDoneSchedules(showDone);
  const shown = showDone ? doneQ : q;
  const allItems = sortSchedules((q.data?.items || []).filter(s => s.status !== "cancelled"));
  const items = showDone ? (doneQ.data?.items || []) : filterSchedules(allItems, filter);
  // One group per channel (in name order), rows inside it live-first, so a
  // channel never shows up twice when it has both active and paused rows.
  // Done is strictly latest finished first instead: one flat list, each row
  // labelled with its channel and group.
  const byChannel = new Map<string, Schedule[]>();
  for (const s of items) byChannel.set(s.channel_id, [...(byChannel.get(s.channel_id) || []), s]);
  const groupsInOrder = showDone ? []
    : [...byChannel.entries()].sort(([, a], [, b]) => scheduleChannelLabel(a[0]).localeCompare(scheduleChannelLabel(b[0])));
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
        {showDone && items.map(s => (
          <ScheduleRow key={s.id} schedule={s} showThread showChannel groupName={scheduleGroupName(s, groups)}
            onOpen={lostChannelAccess(s) ? undefined : open} />
        ))}
        {groupsInOrder.map(([channelId, rows]) => {
          const first = rows[0];
          return (
            <section className="ago-sched-group" key={channelId} aria-label={`Schedules in ${first.channel_name ?? channelId}`}>
              <button className="ago-sched-group-head" disabled={lostChannelAccess(first)}
                onClick={() => open({ ...first, thread_id: null })}>
                <Icon name={first.channel_kind === "agent_dm" ? "bot" : "messages-square"} />
                {first.channel_kind === "agent_dm" ? first.channel_name : `#${first.channel_name ?? channelId}`}
                {groupName(first.group_id) && <span className="dim"> · {groupName(first.group_id)}</span>}
              </button>
              {rows.map(s => <ScheduleRow key={s.id} schedule={s} showThread onOpen={lostChannelAccess(s) ? undefined : open} />)}
            </section>
          );
        })}
        {shown.data?.truncated && <div className="ago-sched-truncated" role="status">{scheduleTruncatedNote(filter)}</div>}
      </div>
    </div>
  );
}
