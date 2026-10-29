import { describe, expect, it } from "vitest";
import {
  customRunAtError,
  defaultCustomRunAt,
  runAtToWheel,
  WHEEL_DAYS,
  wheelDayLabel,
  wheelToRunAt,
  normalizeSchedulePresets,
  presetRunAt,
  scheduledForLabel,
  schedulePresetLabel,
  scheduleTimeZoneNote,
} from "./schedules";

describe("schedule presets", () => {
  it("labels whole days, else whole hours, else minutes", () => {
    expect(schedulePresetLabel(60)).toBe("In 1 hour");
    expect(schedulePresetLabel(180)).toBe("In 3 hours");
    expect(schedulePresetLabel(30)).toBe("In 30 minutes");
    expect(schedulePresetLabel(90)).toBe("In 90 minutes");
    expect(schedulePresetLabel(120)).toBe("In 2 hours");
    expect(schedulePresetLabel(1440)).toBe("In 1 day");
    expect(schedulePresetLabel(2880)).toBe("In 2 days");
    expect(schedulePresetLabel(1500)).toBe("In 25 hours");
    expect(schedulePresetLabel(1)).toBe("In 1 minute");
  });

  it("falls back to 1 and 3 hours for an older server or junk", () => {
    expect(normalizeSchedulePresets(undefined)).toEqual([60, 180]);
    expect(normalizeSchedulePresets("60,180")).toEqual([60, 180]);
    expect(normalizeSchedulePresets([])).toEqual([60, 180]);
    expect(normalizeSchedulePresets([0, -1, 1.5, "x"])).toEqual([60, 180]);
    expect(normalizeSchedulePresets([30, 30, 90])).toEqual([30, 90]);
    expect(normalizeSchedulePresets([1, 2, 3, 4, 5, 6])).toEqual([1, 2, 3, 4, 5]);
  });

  it("counts a preset from now in whole seconds", () => {
    expect(presetRunAt(60, 1_000_000_400)).toBe(1_000_000 + 3600);
  });
});

describe("custom times and labels", () => {
  const now = new Date(2026, 9, 29, 10, 0).getTime();

  it("refuses a missing or past time", () => {
    expect(customRunAtError(null, now)).toBe("Pick a date and time");
    expect(customRunAtError(now / 1000 - 60, now)).toBe("Pick a time in the future");
    expect(customRunAtError(now / 1000 + 60, now)).toBeNull();
  });

  it("says today, tomorrow or the date", () => {
    const at = (d: number, h: number) => new Date(2026, 9, d, h, 30).getTime() / 1000;
    expect(scheduledForLabel(at(29, 16), now, "en-US")).toBe("Scheduled for Today at 4:30 PM");
    expect(scheduledForLabel(at(30, 9), now, "en-US")).toBe("Scheduled for Tomorrow at 9:30 AM");
    expect(scheduledForLabel(at(31, 9), now, "en-US")).toMatch(/^Scheduled for Sat, Oct 31 at 9:30\sAM$/);
  });

  it("names the device's time zone", () => {
    expect(scheduleTimeZoneNote(new Date(now), "en-US")).toMatch(/^All times in \S/);
  });
});

describe("schedule wheel", () => {
  // A fixed local afternoon: Thu 29 Oct 2026, 14:10:30.
  const now = new Date(2026, 9, 29, 14, 10, 30).getTime();

  it("opens on the next whole local hour, including across midnight", () => {
    expect(new Date(defaultCustomRunAt(now) * 1000)).toEqual(new Date(2026, 9, 29, 15, 0));
    expect(new Date(defaultCustomRunAt(new Date(2026, 9, 29, 23, 41).getTime()) * 1000))
      .toEqual(new Date(2026, 9, 30, 0, 0));
    const onTheHour = new Date(2026, 9, 29, 14, 0).getTime();
    expect(new Date(defaultCustomRunAt(onTheHour) * 1000)).toEqual(new Date(2026, 9, 29, 15, 0));
    expect(new Date(defaultCustomRunAt(now) * 1000).getMinutes()).toBe(0);
  });

  it("maps 12 AM to midnight and 12 PM to noon", () => {
    const at = (hour12: number, pm: boolean) => new Date(wheelToRunAt({ day: 1, hour12, minute: 5, pm }, now) * 1000);
    expect(at(12, false)).toEqual(new Date(2026, 9, 30, 0, 5));
    expect(at(12, true)).toEqual(new Date(2026, 9, 30, 12, 5));
    expect(at(1, false)).toEqual(new Date(2026, 9, 30, 1, 5));
    expect(at(11, true)).toEqual(new Date(2026, 9, 30, 23, 5));
  });

  it("round-trips through the columns and clamps to the offered days", () => {
    for (const d of [new Date(2026, 9, 29, 16, 0), new Date(2026, 9, 31, 0, 0), new Date(2026, 10, 2, 12, 59), new Date(2027, 2, 1, 23, 30)]) {
      const runAt = Math.round(d.getTime() / 1000);
      expect(wheelToRunAt(runAtToWheel(runAt, now), now)).toBe(runAt);
    }
    expect(runAtToWheel(Math.round(new Date(2026, 9, 31, 0, 0).getTime() / 1000), now))
      .toEqual({ day: 2, hour12: 12, minute: 0, pm: false });
    expect(runAtToWheel(Math.round(new Date(2026, 9, 1).getTime() / 1000), now).day).toBe(0);
    expect(runAtToWheel(Math.round(new Date(2030, 0, 1).getTime() / 1000), now).day).toBe(WHEEL_DAYS - 1);
  });

  it("labels today and later days like the iOS wheel", () => {
    expect(wheelDayLabel(0, now, "en-US")).toBe("Today");
    expect(wheelDayLabel(1, now, "en-US")).toBe("Fri Oct 30");
    expect(wheelDayLabel(3, now, "en-US")).toBe("Sun Nov 1");
  });
});
