/* Schedule cadence text and the live-refresh contract for schedule lists. */

import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { applyWsEvent } from "../src/ws/reducer";
import { keys } from "../src/api/keys";
import {
  describeCron, describeSchedule, formatUtc, intervalParts, intervalSeconds, lostChannelAccess, nextRunsLabel, scheduledLabel,
  scheduledTitle, sortSchedules,
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
