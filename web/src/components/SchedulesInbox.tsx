import { sortSchedules, useAllSchedules, useGroups, type Schedule } from "@agora/core";
import { Icon } from "../lib/icons";
import { useUiState } from "../state/ui";
import { ScheduleEmpty, ScheduleRow } from "./SchedulesPane";

/** Every schedule in channels the caller can access (admins: all channels;
    DMs stay owner-only), grouped by channel. */
export function SchedulesInbox() {
  const q = useAllSchedules();
  const ui = useUiState();
  const groups = useGroups().data || [];
  const groupName = (id: string | null) => groups.find(g => g.id === id)?.name ?? "";
  const items = sortSchedules((q.data?.items || []).filter(s => s.status !== "cancelled"));
  const byChannel = new Map<string, Schedule[]>();
  for (const s of items) byChannel.set(s.channel_id, [...(byChannel.get(s.channel_id) || []), s]);
  const open = (s: Schedule) => {
    if (!s.group_id) return;
    ui.selectChannel(s.group_id, s.channel_id);
    if (s.thread_id != null) ui.openThread(s.thread_id);
  };
  return (
    <div className="ago-inbox-content ago-sched-inbox">
      <div className="ago-log">
        {q.isLoading && <div className="empty">Loading schedules…</div>}
        {q.isError && <div className="empty">Couldn't load schedules. <button className="btn sm" onClick={() => void q.refetch()}>Retry</button></div>}
        {!q.isLoading && !q.isError && !items.length && <ScheduleEmpty />}
        {[...byChannel.entries()].map(([channelId, rows]) => {
          const first = rows[0];
          return (
            <section className="ago-sched-group" key={channelId} aria-label={`Schedules in ${first.channel_name ?? channelId}`}>
              <button className="ago-sched-group-head" onClick={() => open({ ...first, thread_id: null })}>
                <Icon name={first.channel_kind === "agent_dm" ? "bot" : "messages-square"} />
                {first.channel_kind === "agent_dm" ? first.channel_name : `#${first.channel_name ?? channelId}`}
                {groupName(first.group_id) && <span className="dim"> · {groupName(first.group_id)}</span>}
              </button>
              {rows.map(s => <ScheduleRow key={s.id} schedule={s} showThread onOpen={open} />)}
            </section>
          );
        })}
      </div>
    </div>
  );
}
