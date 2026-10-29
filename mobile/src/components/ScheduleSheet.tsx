/* Long-press Send → schedule the typed message for later: a bottom sheet with
   the server's quick presets ("In 1 hour", "In 3 hours") and a custom date
   and time, all in the device's own time zone. iOS picks the custom time on
   an inline spinner; Android has no combined date-time spinner, so it opens
   the system date and then time dialogs. */

import React, { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Platform, Pressable, Text, View } from "react-native";
import DateTimePicker, { DateTimePickerAndroid, type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import {
  customRunAtError,
  presetRunAt,
  schedulePresetLabel,
  scheduleTimeZoneNote,
} from "@agora/core";
import { typography, weight } from "../lib/theme";
import { createThemedStyles, useAppTheme } from "../lib/useTheme";

/** The custom picker opens on the next whole hour after one from now. */
export function defaultCustomTime(nowMs: number = Date.now()): Date {
  return new Date((Math.ceil(nowMs / 3_600_000) + 1) * 3_600_000);
}

export function ScheduleSheet({
  visible,
  presets,
  pending,
  onClose,
  onSchedule,
}: {
  visible: boolean;
  /** Minutes from now (useSchedulePresets). */
  presets: number[];
  pending?: boolean;
  onClose: () => void;
  onSchedule: (runAt: number) => void;
}) {
  const { colors, mode } = useAppTheme();
  const styles = useStyles();
  const [custom, setCustom] = useState(false);
  const [at, setAt] = useState(() => defaultCustomTime());
  const [error, setError] = useState<string | null>(null);
  const reset = () => { setCustom(false); setError(null); setAt(defaultCustomTime()); };
  // The sheet stays mounted with the composer: start every opening fresh so
  // the custom time never defaults to one that has since passed.
  useEffect(() => { if (visible) reset(); }, [visible]);
  const close = () => { reset(); onClose(); };
  const submitCustom = () => {
    const runAt = Math.round(at.getTime() / 1000);
    const problem = customRunAtError(runAt);
    if (problem) { setError(problem); return; }
    setError(null);
    onSchedule(runAt);
  };
  const pickAndroid = (mode: "date" | "time") => {
    DateTimePickerAndroid.open({
      value: at,
      mode,
      minimumDate: mode === "date" ? new Date() : undefined,
      onChange: (e: DateTimePickerEvent, d?: Date) => {
        if (e.type === "set" && d) { setAt(d); setError(null); }
      },
    });
  };
  const dateLabel = at.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const timeLabel = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close} accessibilityLabel="Close schedule options">
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.grip} />
          <View style={styles.head}>
            <Text style={styles.title} accessibilityRole="header">Schedule message</Text>
            <Text style={styles.note}>{scheduleTimeZoneNote()}</Text>
          </View>
          <View style={styles.group}>
            {presets.map((minutes) => (
              <Pressable key={minutes} style={styles.row} disabled={pending} accessibilityRole="button"
                accessibilityLabel={schedulePresetLabel(minutes)}
                onPress={() => onSchedule(presetRunAt(minutes))}>
                <Text style={styles.rowText}>{schedulePresetLabel(minutes)}</Text>
              </Pressable>
            ))}
          </View>
          <View style={[styles.group, styles.divided]}>
            <Pressable style={styles.row} accessibilityRole="button" accessibilityLabel="Custom time"
              accessibilityState={{ expanded: custom }}
              onPress={() => setCustom((v) => !v)}>
              <Text style={styles.rowText}>Custom time</Text>
            </Pressable>
            {custom ? (
              <View style={styles.custom}>
                {Platform.OS === "ios" ? (
                  <DateTimePicker
                    testID="schedule-custom-picker"
                    value={at}
                    mode="datetime"
                    display="spinner"
                    minimumDate={new Date()}
                    themeVariant={mode}
                    onChange={(_e: DateTimePickerEvent, d?: Date) => { if (d) { setAt(d); setError(null); } }}
                  />
                ) : (
                  <View style={styles.androidPick}>
                    <Pressable style={styles.androidField} accessibilityRole="button"
                      accessibilityLabel={`Date, ${dateLabel}`} onPress={() => pickAndroid("date")}>
                      <Text style={styles.androidText}>{dateLabel}</Text>
                    </Pressable>
                    <Pressable style={styles.androidField} accessibilityRole="button"
                      accessibilityLabel={`Time, ${timeLabel}`} onPress={() => pickAndroid("time")}>
                      <Text style={styles.androidText}>{timeLabel}</Text>
                    </Pressable>
                  </View>
                )}
                {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
                <Pressable style={[styles.go, pending && styles.goOff]} disabled={pending} accessibilityRole="button"
                  accessibilityLabel="Schedule message" onPress={submitCustom}>
                  {pending ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.goText}>Schedule message</Text>}
                </Pressable>
              </View>
            ) : null}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const useStyles = createThemedStyles(({ colors, surfaces }) => ({
  backdrop: { flex: 1, backgroundColor: colors.scrim, justifyContent: "flex-end" },
  sheet: { ...surfaces.sheet, paddingHorizontal: 0, paddingTop: 8, paddingBottom: 34 },
  grip: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: colors.borderStrong, marginBottom: 10 },
  head: { paddingHorizontal: 20, paddingBottom: 12, gap: 2 },
  title: { color: colors.text, fontSize: typography.title.fontSize, fontWeight: weight.bold },
  note: { color: colors.dim, fontSize: typography.meta.fontSize },
  group: { paddingVertical: 4 },
  divided: { borderTopWidth: 1, borderTopColor: colors.border },
  row: { minHeight: 50, paddingHorizontal: 20, justifyContent: "center" },
  rowText: { color: colors.text, fontSize: typography.body.fontSize },
  custom: { paddingHorizontal: 16, paddingBottom: 8, gap: 10 },
  androidPick: { flexDirection: "row", gap: 10 },
  androidField: {
    flex: 1, minHeight: 46, borderRadius: 10, borderWidth: 1, borderColor: colors.borderStrong,
    alignItems: "center", justifyContent: "center",
  },
  androidText: { color: colors.text, fontSize: typography.body.fontSize, fontWeight: weight.semibold },
  error: { color: colors.red, fontSize: typography.meta.fontSize },
  go: { backgroundColor: colors.accent, borderRadius: 12, minHeight: 48, alignItems: "center", justifyContent: "center" },
  goOff: { opacity: 0.5 },
  goText: { color: colors.onAccent, fontSize: typography.message.fontSize, fontWeight: weight.bold },
}));
