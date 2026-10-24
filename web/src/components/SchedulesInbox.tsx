import { useState } from "react";
import { filterSchedules, type ScheduleFilter, lostChannelAccess, SCHEDULES_TRUNCATED_NOTE, sortSchedules, useAllSchedules, useGroups, type Schedule } from "@agora/core";
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
  const [filter, setFilter] = useState<ScheduleFilter>("all");
  const allItems = sortSchedules((q.data?.items || []).filter(s => s.status !== "cancelled"));
  const items = filterSchedules(allItems, filter);
  // One group per channel (in name order), rows inside it live-first, so a
  // channel never shows up twice when it has both active and paused rows.
  const byChannel = new Map<string, Schedule[]>();
  for (const s of items) byChannel.set(s.channel_id, [...(byChannel.get(s.channel_id) || []), s]);
  const groupLabel = (s: Schedule) => s.channel_kind === "agent_dm" ? s.channel_name ?? s.channel_id : `#${s.channel_name ?? s.channel_id}`;
  const groupsInOrder = [...byChannel.entries()].sort(([, a], [, b]) => groupLabel(a[0]).localeCompare(groupLabel(b[0])));
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
      <ScheduleFilters items={allItems} value={filter} onChange={setFilter} />
      <div className="ago-log">
        {q.isLoading && <div className="empty">Loading schedules…</div>}
        {q.isError && <div className="empty">Couldn't load schedules. <button className="btn sm" onClick={() => void q.refetch()}>Retry</button></div>}
        {!q.isLoading && !q.isError && !items.length && <ScheduleEmpty filter={filter} />}
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
        {q.data?.truncated && <div className="ago-sched-truncated" role="status">{SCHEDULES_TRUNCATED_NOTE}</div>}
      </div>
    </div>
  );
}
