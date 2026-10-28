/* Human-readable schedule cadences. Cron rules are 5-field and evaluated in
   UTC on the server (the Pantheo spec), so cron text always says "UTC";
   anything this compact describer doesn't recognise falls back to the raw
   rule rather than guessing. Kept dependency-free on purpose: the common
   loop shapes (every N, daily, weekdays, monthly) cover what agents create. */

import { DM_GROUP_ID, type MessageMeta, type Schedule, type ScheduleList, type ScheduleSpec } from "../api/types";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type IntervalUnit = "seconds" | "minutes" | "hours" | "days";

const UNIT_SECONDS: Record<IntervalUnit, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };

/** The largest whole unit an interval divides into, for display and editing.
 *  Never rounds: a gap that isn't whole minutes stays in seconds, so saving
 *  an editor pre-filled from it sends back exactly the same interval. */
export function intervalParts(seconds: number): { count: number; unit: IntervalUnit } {
  for (const unit of ["days", "hours", "minutes"] as const) {
    if (seconds >= UNIT_SECONDS[unit] && seconds % UNIT_SECONDS[unit] === 0)
      return { count: seconds / UNIT_SECONDS[unit], unit };
  }
  return { count: Math.max(1, Math.round(seconds)), unit: "seconds" };
}

export function intervalSeconds(count: number, unit: IntervalUnit): number {
  return Math.round(count) * UNIT_SECONDS[unit];
}

function plural(count: number, word: string): string {
  return count === 1 ? `Every ${word}` : `Every ${count} ${word}s`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "Oct 25, 2026 07:00 UTC" — schedules are defined in UTC, so the label is too. */
export function formatUtc(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "Mon, Oct 26, 09:00" in the device's own time zone (for what a person
    asked for in local time; pair it with `formatUtc` where UTC matters). */
export function formatLocal(unixSeconds: number, locale?: string): string {
  return new Date(unixSeconds * 1000).toLocaleString(locale, {
    weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
}

const isNum = (f: string) => /^\d+$/.test(f);
const isNumList = (f: string) => /^\d+(,\d+)*$/.test(f);

function timeList(minute: string, hours: string): string {
  const times = hours.split(",").map(h => `${pad(Number(h))}:${pad(Number(minute))}`);
  return times.length === 1 ? times[0] : `${times.slice(0, -1).join(", ")} and ${times[times.length - 1]}`;
}

function dayIndex(field: string): number { return Number(field) % 7; }

function describeDays(dow: string): string | null {
  if (dow === "1-5") return "Weekdays";
  if (dow === "0,6" || dow === "6,0" || dow === "6,7" || dow === "6-7") return "Weekends";
  if (isNum(dow)) return `Every ${DAY_NAMES[dayIndex(dow)]}`;
  if (isNumList(dow)) return `Every ${dow.split(",").map(d => SHORT_DAYS[dayIndex(d)]).join(", ")}`;
  return null;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Readable text for a 5-field UTC cron rule, or null when unrecognised. */
export function describeCron(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [min, hour, dom, mon, dow] = fields;
  if (mon !== "*") return null;
  if (min === "*" && hour === "*" && dom === "*" && dow === "*") return "Every minute";
  const everyMin = /^\*\/(\d+)$/.exec(min);
  if (everyMin && hour === "*" && dom === "*" && dow === "*") return plural(Number(everyMin[1]), "minute");
  if (!isNum(min)) return null;
  const at = `:${pad(Number(min))}`;
  if (hour === "*" && dom === "*" && dow === "*") return `Every hour at ${at}`;
  const everyHour = /^\*\/(\d+)$/.exec(hour);
  if (everyHour && dom === "*" && dow === "*") return `${plural(Number(everyHour[1]), "hour")} at ${at}`;
  if (!isNumList(hour)) return null;
  const times = `${timeList(min, hour)} UTC`;
  if (dom === "*" && dow === "*") return `Daily at ${times}`;
  if (dom === "*") {
    const days = describeDays(dow);
    return days ? `${days} at ${times}` : null;
  }
  if (isNum(dom) && dow === "*") return `Monthly on the ${ordinal(Number(dom))} at ${times}`;
  return null;
}

/** One line describing when a schedule fires. */
export function describeSchedule(spec: ScheduleSpec): string {
  switch (spec.kind) {
    case "once": return `Once at ${formatUtc(spec.at)}`;
    case "interval": {
      const { count, unit } = intervalParts(spec.seconds);
      return plural(count, unit.slice(0, -1));
    }
    case "cron": return describeCron(spec.expr) ?? `Cron "${spec.expr}" (UTC)`;
  }
}

/** Display order: upcoming active first (soonest), then paused, then finished. */
export function sortSchedules(items: Schedule[]): Schedule[] {
  const rank = (s: Schedule) => (s.status === "active" ? 0 : s.status === "paused" ? 1 : 2);
  return [...items].sort((a, b) => rank(a) - rank(b) || a.run_at - b.run_at);
}

/** Tag for a message a schedule posted: "Scheduled", or "Scheduled · written
    by <agent>" when an agent wrote its words (it posts as the owner, so
    readers should know who actually drafted it). */
export function scheduledLabel(meta: MessageMeta | null | undefined): string {
  const writer = meta?.written_by_agent_name || meta?.written_by_agent;
  return writer ? `Scheduled · written by ${writer}` : "Scheduled";
}

/** Longer hover/accessibility text for the same tag. */
export function scheduledTitle(meta: MessageMeta | null | undefined): string {
  const writer = meta?.written_by_agent_name || meta?.written_by_agent;
  return writer
    ? `Posted by a schedule on the author's behalf; ${writer} wrote the message`
    : "Posted by a schedule on the author's behalf";
}

/** Prefix for a row's upcoming times: a paused schedule's `next_runs` are
    what resuming would schedule, not times it will post on its own. */
export function nextRunsLabel(status: Schedule["status"]): string {
  return status === "paused" ? "If resumed:" : "Next:";
}

/** The owner was removed from the schedule's channel: it still posts in
    their name unless stopped, so they keep Pause and Cancel (no Resume or
    retime) to stop it. */
export function lostChannelAccess(schedule: Schedule): boolean {
  return schedule.channel_access === false;
}

export const LOST_ACCESS_NOTE = "You no longer have access to this channel";

/** Shown under a schedule list the server capped (it keeps active ones first). */
export const SCHEDULES_TRUNCATED_NOTE = "Showing the first 1,000 schedules (active first). Others are not listed here.";
/** The same for the Done tab, whose list is latest finished first. */
export const SCHEDULES_DONE_TRUNCATED_NOTE = "Showing the 1,000 most recently finished schedules. Older ones are not listed here.";
export function scheduleTruncatedNote(filter: ScheduleFilter): string {
  return filter === "done" ? SCHEDULES_DONE_TRUNCATED_NOTE : SCHEDULES_TRUNCATED_NOTE;
}

/** Filters apply to the loaded list; counts do not imply a server-wide total.
 *  "done" is the exception: that tab loads every finished schedule on its own
 *  (the default list keeps only the last week's), latest finished first. */
export const SCHEDULE_FILTERS = ["all", "active", "paused", "done"] as const;
export type ScheduleFilter = typeof SCHEDULE_FILTERS[number];
export const scheduleFilterLabel: Record<ScheduleFilter, string> = { all: "All", active: "Active", paused: "Paused", done: "Done" };
/** Keep the rows of one tab, in the caller's order: callers sort (or group by
 *  channel) first, and re-sorting here would scatter a grouped list. */
export function filterSchedules(items: Schedule[], filter: ScheduleFilter): Schedule[] {
  return items.filter(item => filter === "all" || item.status === filter);
}
/** A tab's count. Done counts the separately loaded done list (`done`,
 *  undefined until that tab has been opened), never the default list's
 *  recent few, which would undercount it. */
export function scheduleFilterCount(items: Schedule[], filter: ScheduleFilter, done?: Schedule[]): number {
  if (filter === "done") return done?.length ?? 0;
  return items.filter(item => filter === "all" || item.status === filter).length;
}
/** Keeps only finished rows of a Done response (and its `truncated`): a
 *  server that predates `?status=done` ignores it and returns the live list,
 *  whose active and paused rows don't belong on that tab. */
export function onlyDone(list: ScheduleList): ScheduleList {
  const items = list.items.filter(item => item.status === "done");
  return items.length === list.items.length ? list : { ...list, items };
}

/** The Done list to count on its badge, or undefined to show none. A count
 *  shows once the data was fetched at or after the tab was last opened
 *  (`openedAt`, ms; null = not open): reopening hides a cached count from an
 *  earlier visit until fresh data lands, but a background refetch while the
 *  tab stays open keeps it (its data is already from this visit). */
export function doneBadgeList(
  query: { data?: ScheduleList; dataUpdatedAt: number },
  openedAt: number | null,
): ScheduleList | undefined {
  if (openedAt == null || !query.data) return undefined;
  return query.dataUpdatedAt >= openedAt ? query.data : undefined;
}

/** A tab's badge text: "" for none, else its count, with "+" on Done when
 *  the server capped that list (there are more than it returned). */
export function scheduleFilterBadge(items: Schedule[], filter: ScheduleFilter, done?: ScheduleList): string {
  const count = scheduleFilterCount(items, filter, done?.items);
  if (!count) return "";
  return `${count.toLocaleString()}${filter === "done" && done?.truncated ? "+" : ""}`;
}
/** A schedule's channel (and group, when known) as one short label, for
 *  lists that don't group rows under channel headings (the Done tab, which
 *  is strictly latest finished first). Agent DMs show the agent's name. */
export function scheduleChannelLabel(schedule: Schedule, groupName?: string): string {
  const channel = schedule.channel_kind === "agent_dm"
    ? schedule.channel_name || "Direct message"
    : `#${schedule.channel_name || schedule.channel_id}`;
  return groupName ? `${channel} · ${groupName}` : channel;
}

/** The name of the group a schedule's channel is in, for its label. Agent
 *  DMs carry group_id "" but are listed under the synthetic DMs group
 *  ("__dms"), which isn't always in `groups`: fall back to its name. */
export function scheduleGroupName(schedule: Schedule, groups: { id: string; name: string }[] | undefined): string | undefined {
  const dm = schedule.channel_kind === "agent_dm" || schedule.group_id === "";
  const id = dm ? DM_GROUP_ID : schedule.group_id;
  return groups?.find(g => g.id === id)?.name || (dm ? "Direct messages" : undefined);
}

/** Empty-state copy for a filtered tab (the "all" tab has its own). */
export function scheduleEmptyCopy(filter: Exclude<ScheduleFilter, "all">): { title: string; description: string } {
  const description = {
    active: "Schedules ready to run will appear here.",
    paused: "Schedules you pause will appear here.",
    done: "Schedules that have finished posting will appear here.",
  }[filter];
  return { title: `No ${filter} schedules`, description };
}

/** The server sets this as a schedule's last_error when a post @mentioned an
 *  agent that wasn't connected as it fired (matches hub/scheduler.rs). */
export const SCHEDULE_OFFLINE_AGENT_ERROR =
  "An agent this message mentions wasn't connected when it posted, so it may not have received it.";
