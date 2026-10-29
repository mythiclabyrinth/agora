import { describe, expect, it } from "vitest";
import {
  customRunAtError,
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
