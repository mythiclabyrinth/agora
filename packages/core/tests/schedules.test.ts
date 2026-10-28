/* Schedule cadence text and the live-refresh contract for schedule lists. */

import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { applyWsEvent } from "../src/ws/reducer";
import { keys } from "../src/api/keys";
import {
  describeCron, describeSchedule, filterSchedules, formatUtc, intervalParts, intervalSeconds, lostChannelAccess, nextRunsLabel,
  doneBadgeList, onlyDone, SCHEDULE_FILTERS, scheduleChannelLabel, scheduleEmptyCopy, scheduleFilterBadge, scheduleGroupName, scheduleFilterCount, scheduledLabel, scheduledTitle, scheduleTruncatedNote, sortSchedules, sortSchedulesByTime,
} from "../src/lib/schedules";
import { fixtureSchedules } from "../testing/fixtures";

describe("describeSchedule", () => {
  it("describes one-offs in UTC", () => {
    const at = Date.UTC(2026, 9, 25, 7, 0) / 1000;
    expect(describeSchedule({ kind: "once", at })).toBe("Once at Oct 25, 2026 07:00 UTC");
    expect(formatUtc(at)).toBe("Oct 25, 2026 07:00 UTC");
  });

  it("describes intervals in the largest whole unit", () => {
    expect(describeSchedule({ kind: "interval", seconds: 21600 })).toBe("Every 6 hours");
    expect(describeSchedule({ kind: "interval", seconds: 86400 })).toBe("Every day");
    expect(describeSchedule({ kind: "interval", seconds: 300 })).toBe("Every 5 minutes");
    expect(describeSchedule({ kind: "interval", seconds: 5400 })).toBe("Every 90 minutes");
    expect(intervalParts(172800)).toEqual({ count: 2, unit: "days" });
    expect(intervalSeconds(3, "hours")).toBe(10800);
  });

  it("keeps intervals that aren't whole minutes exact", () => {
    // Rounding to minutes would let a no-edit Save change the cadence.
    expect(intervalParts(330)).toEqual({ count: 330, unit: "seconds" });
    expect(intervalSeconds(intervalParts(330).count, intervalParts(330).unit)).toBe(330);
    expect(describeSchedule({ kind: "interval", seconds: 330 })).toBe("Every 330 seconds");
    for (const s of [300, 330, 3600, 5400, 86400, 90061])
      expect(intervalSeconds(intervalParts(s).count, intervalParts(s).unit)).toBe(s);
  });

  it("describes the common cron shapes and falls back to the rule", () => {
    expect(describeCron("*/30 * * * *")).toBe("Every 30 minutes");
    expect(describeCron("15 * * * *")).toBe("Every hour at :15");
    expect(describeCron("20 */6 * * *")).toBe("Every 6 hours at :20");
    expect(describeCron("0 7 * * *")).toBe("Daily at 07:00 UTC");
    expect(describeCron("30 6,18 * * *")).toBe("Daily at 06:30 and 18:30 UTC");
    expect(describeCron("0 7 * * 1-5")).toBe("Weekdays at 07:00 UTC");
    expect(describeCron("0 9 * * 0,6")).toBe("Weekends at 09:00 UTC");
    expect(describeCron("0 8 * * 1")).toBe("Every Monday at 08:00 UTC");
    expect(describeCron("0 8 * * 1,3")).toBe("Every Mon, Wed at 08:00 UTC");
    expect(describeCron("0 9 1 * *")).toBe("Monthly on the 1st at 09:00 UTC");
    expect(describeCron("0 9 * 1 *")).toBeNull();
    expect(describeSchedule({ kind: "cron", expr: "5 4 * 2 1" })).toBe('Cron "5 4 * 2 1" (UTC)');
  });

  it("orders active by next run, then paused, then finished", () => {
    const order = sortSchedules(fixtureSchedules).map(s => s.status);
    expect(order).toEqual(["active", "active", "paused"]);
  });

  it("orders one flat list by next run, then finished rows by last run, newest first", () => {
    const base = fixtureSchedules[0];
    const row = (id: string, status: "active" | "paused" | "done", next: number | null, last: number | null, finished?: number) =>
      ({ ...base, id, status, run_at: next ?? 0, next_runs: next == null ? [] : [next], last_run_at: last, finished_at: finished ?? null, updated_at: 1 });
    const order = sortSchedulesByTime([
      row("done-old", "done", null, 100),
      row("paused-mid", "paused", 500, null),
      row("active-late", "active", 900, null),
      row("done-new", "done", null, null, 300),
      row("active-soon", "active", 200, null),
    ]).map(s => s.id);
    expect(order).toEqual(["active-soon", "paused-mid", "active-late", "done-new", "done-old"]);
  });
});

describe("schedules_changed", () => {
  it("refreshes the channel's lists (thread ones too) and the inbox list only", () => {
    const qc = new QueryClient();
    const stale = (key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated;
    qc.setQueryData(keys.schedules("c1", null), { items: [] });
    qc.setQueryData(keys.schedules("c1", 7), { items: [] });
    qc.setQueryData(keys.schedules("c2", null), { items: [] });
    qc.setQueryData(keys.allSchedules, { items: [] });
    applyWsEvent(qc, { type: "schedules_changed", channel_id: "c1", thread_id: 7 }, { username: "ana" });
    expect(stale(keys.schedules("c1", null))).toBe(true);
    expect(stale(keys.schedules("c1", 7))).toBe(true);
    expect(stale(keys.allSchedules)).toBe(true);
    expect(stale(keys.schedules("c2", null))).toBe(false);
  });

  it("refreshes the Done lists with them", () => {
    const qc = new QueryClient();
    const stale = (key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated;
    qc.setQueryData(keys.doneSchedules("c1", null), { items: [] });
    qc.setQueryData(keys.doneSchedules("c2", null), { items: [] });
    qc.setQueryData(keys.allDoneSchedules, { items: [] });
    applyWsEvent(qc, { type: "schedules_changed", channel_id: "c1", thread_id: null }, { username: "ana" });
    expect(stale(keys.doneSchedules("c1", null))).toBe(true);
    expect(stale(keys.allDoneSchedules)).toBe(true);
    expect(stale(keys.doneSchedules("c2", null))).toBe(false);
  });
});

describe("schedule filters", () => {
  const at = (status: (typeof fixtureSchedules)[number]["status"], id: string) => ({ ...fixtureSchedules[0], id, status });
  const live = [at("active", "a"), at("paused", "p"), at("done", "recent-done")];

  it("has a Done tab after Paused", () => {
    expect(SCHEDULE_FILTERS).toEqual(["all", "active", "paused", "done"]);
  });

  it("counts Done from its own list, not the default list's recent few", () => {
    expect(scheduleFilterCount(live, "all")).toBe(3);
    expect(scheduleFilterCount(live, "active")).toBe(1);
    expect(scheduleFilterCount(live, "done")).toBe(0);
    const done = [at("done", "d1"), at("done", "d2"), at("done", "d3")];
    expect(scheduleFilterCount(live, "done", done)).toBe(3);
  });

  it("keeps the caller's order when filtering", () => {
    expect(filterSchedules(live, "paused").map(s => s.id)).toEqual(["p"]);
    expect(filterSchedules(live, "all").map(s => s.id)).toEqual(["a", "p", "recent-done"]);
  });

  it("labels a row's channel and group for the flat Done list", () => {
    const row = { ...fixtureSchedules[0], channel_name: "agora", channel_kind: "channel" as const };
    expect(scheduleChannelLabel(row, "Projects")).toBe("#agora · Projects");
    expect(scheduleChannelLabel(row)).toBe("#agora");
    expect(scheduleChannelLabel({ ...row, channel_kind: "agent_dm", channel_name: "Claude" }, "Direct messages")).toBe("Claude · Direct messages");
  });

  it("finds a DM schedule's group under the synthetic DMs group", () => {
    const dm = { ...fixtureSchedules[0], channel_kind: "agent_dm" as const, channel_name: "Claude", group_id: "" };
    const groups = [{ id: "product", name: "Product" }, { id: "__dms", name: "Direct messages" }];
    expect(scheduleGroupName(dm, groups)).toBe("Direct messages");
    expect(scheduleChannelLabel(dm, scheduleGroupName(dm, []))).toBe("Claude · Direct messages");
    expect(scheduleGroupName({ ...fixtureSchedules[0], group_id: "product" }, groups)).toBe("Product");
    expect(scheduleGroupName({ ...fixtureSchedules[0], group_id: "gone" }, groups)).toBeUndefined();
  });

  it("keeps only finished rows when an older server ignores ?status=done", () => {
    const mixed = { items: [at("active", "a"), at("done", "d1"), at("paused", "p"), at("done", "d2")], truncated: true };
    expect(onlyDone(mixed)).toEqual({ items: [at("done", "d1"), at("done", "d2")], truncated: true });
    const clean = { items: [at("done", "d1")] };
    expect(onlyDone(clean)).toBe(clean);
  });

  it("counts Done from data fetched since the tab was opened", () => {
    const data = { items: [at("done", "d1")] };
    // Not open: no count.
    expect(doneBadgeList({ data, dataUpdatedAt: 200 }, null)).toBeUndefined();
    // Reopened at 300 over a cached list from 200: hidden until fresh data.
    expect(doneBadgeList({ data, dataUpdatedAt: 200 }, 300)).toBeUndefined();
    expect(doneBadgeList({ data, dataUpdatedAt: 300 }, 300)).toBe(data);
    // A background refetch while open keeps the (this-visit) data counted.
    expect(doneBadgeList({ data, dataUpdatedAt: 350 }, 300)).toBe(data);
    expect(doneBadgeList({ dataUpdatedAt: 0 }, 300)).toBeUndefined();
  });

  it("marks a capped Done list's badge with +", () => {
    const done = Array.from({ length: 1000 }, (_, i) => at("done", `d${i}`));
    expect(scheduleFilterBadge(live, "done", { items: done, truncated: true })).toBe("1,000+");
    expect(scheduleFilterBadge(live, "done", { items: done })).toBe("1,000");
    expect(scheduleFilterBadge(live, "done")).toBe("");
    expect(scheduleFilterBadge(live, "active", { items: done, truncated: true })).toBe("1");
  });

  it("explains empty tabs and capped lists per tab", () => {
    expect(scheduleEmptyCopy("done").title).toBe("No done schedules");
    expect(scheduleEmptyCopy("paused").description).toMatch(/pause/);
    expect(scheduleTruncatedNote("done")).toMatch(/most recently finished/);
    expect(scheduleTruncatedNote("all")).toMatch(/active first/);
  });
});

describe("scheduledLabel", () => {
  it("names the agent that wrote a scheduled post", () => {
    const meta = { scheduled: true, written_by_agent: "claude", written_by_agent_name: "Claude" };
    expect(scheduledLabel(meta)).toBe("Scheduled · written by Claude");
    expect(scheduledTitle(meta)).toContain("Claude wrote the message");
    expect(scheduledLabel({ scheduled: true, written_by_agent: "claude" })).toBe("Scheduled · written by claude");
  });
  it("stays plain when no agent wrote it", () => {
    expect(scheduledLabel({ scheduled: true })).toBe("Scheduled");
    expect(scheduledTitle(null)).toBe("Posted by a schedule on the author's behalf");
  });
});

describe("schedule row helpers", () => {
  it("labels a paused schedule's times as what resuming would do", () => {
    expect(nextRunsLabel("paused")).toBe("If resumed:");
    expect(nextRunsLabel("active")).toBe("Next:");
  });

  it("flags only rows whose channel the viewer lost", () => {
    const [s] = fixtureSchedules;
    expect(lostChannelAccess({ ...s, channel_access: false })).toBe(true);
    expect(lostChannelAccess({ ...s, channel_access: true })).toBe(false);
    expect(lostChannelAccess({ ...s, channel_access: undefined })).toBe(false);
  });
});
