/* Long-press Send → schedule the typed message for later: a bottom sheet with
   the server's quick presets ("In 1 hour", "In 3 hours") and a custom date
   and time, all in the device's own time zone. iOS picks the custom time on
   its native date-and-time spinner; Android has no combined one, so it gets
   the same wheel drawn in React Native (DateTimeWheel). */

import React, { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { X } from "lucide-react-native";
import { Icon } from "./Icon";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import {
  customRunAtError,
  defaultCustomRunAt,
  presetRunAt,
  schedulePresetLabel,
  scheduleTimeZoneNote,
} from "@agora/core";
import { typography, weight } from "../lib/theme";
import { createThemedStyles, useAppTheme } from "../lib/useTheme";
import { DateTimeWheel } from "./DateTimeWheel";

/** The custom picker opens on the next whole local hour. */
export function defaultCustomTime(nowMs: number = Date.now()): Date {
  return new Date(defaultCustomRunAt(nowMs) * 1000);
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
  const insets = useSafeAreaInsets();
  const [custom, setCustom] = useState(false);
  const [at, setAt] = useState(() => defaultCustomTime());
  const [minimumDate, setMinimumDate] = useState(() => new Date());
  const [error, setError] = useState<string | null>(null);
  const [settling, setSettling] = useState(false);
  const reset = () => { setCustom(false); setSettling(false); setError(null); setAt(defaultCustomTime()); };
  // The sheet stays mounted with the composer: start every opening fresh so
  // the custom time never defaults to one that has since passed.
  useEffect(() => {
    if (visible) {
      setMinimumDate(new Date());
      reset();
    }
  }, [visible]);
  const close = () => { reset(); onClose(); };
  const submitCustom = () => {
    if (pending || settling) return;
    const runAt = Math.round(at.getTime() / 1000);
    const problem = customRunAtError(runAt);
    if (problem) { setError(problem); return; }
    setError(null);
    onSchedule(runAt);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close} accessible={false}>
        <Pressable style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]} onPress={() => {}} accessible={false} accessibilityViewIsModal>
          <View style={styles.grip} />
          <View style={styles.head}>
            <Text style={styles.title} accessibilityRole="header">Schedule message</Text>
            <Text style={styles.note}>{scheduleTimeZoneNote()}</Text>
            <Pressable style={styles.close} accessibilityRole="button" accessibilityLabel="Close schedule options" onPress={close}>
              <Icon icon={X} size={20} color={colors.dim} />
            </Pressable>
          </View>
          <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" style={styles.scroll}>
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
              disabled={pending} accessibilityState={{ expanded: custom, disabled: !!pending }}
              onPress={() => { setSettling(false); setCustom((v) => !v); }}>
              <Text style={styles.rowText}>Custom time</Text>
            </Pressable>
            {custom ? (
              <View style={styles.custom}>
                <View pointerEvents={pending ? "none" : "auto"} accessibilityElementsHidden={pending} importantForAccessibility={pending ? "no-hide-descendants" : "auto"}>
                {Platform.OS === "ios" ? (
                  <DateTimePicker
                    testID="schedule-custom-picker"
                    value={at}
                    mode="datetime"
                    display="spinner"
                    minimumDate={minimumDate}
                    themeVariant={mode}
                    onChange={(_e: DateTimePickerEvent, d?: Date) => { if (d) { setAt(d); setError(null); } }}
                  />
                ) : (
                  <DateTimeWheel value={at} onChange={(d) => { setAt(d); setError(null); }} onSettlingChange={setSettling} />
                )}
                </View>
                {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
                <Pressable style={[styles.go, (pending || settling) && styles.goOff]} disabled={pending || settling} accessibilityRole="button"
                  accessibilityState={{ disabled: !!pending || settling, busy: !!pending }}
                  accessibilityLabel="Schedule message" onPress={submitCustom}>
                  {pending ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.goText}>Schedule message</Text>}
                </Pressable>
              </View>
            ) : null}
          </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const useStyles = createThemedStyles(({ colors, surfaces }) => ({
  backdrop: { flex: 1, backgroundColor: colors.scrim, justifyContent: "flex-end" },
  sheet: { ...surfaces.sheet, maxHeight: "90%", paddingHorizontal: 0, paddingTop: 8 },
  scroll: { flexShrink: 1 },
  grip: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: colors.borderStrong, marginBottom: 10 },
  head: { paddingLeft: 20, paddingRight: 60, paddingBottom: 12, gap: 2 },
  close: { position: "absolute", top: -6, right: 8, width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  title: { color: colors.text, fontSize: typography.title.fontSize, fontWeight: weight.bold },
  note: { color: colors.dim, fontSize: typography.meta.fontSize },
  group: { paddingVertical: 4 },
  divided: { borderTopWidth: 1, borderTopColor: colors.border },
  row: { minHeight: 50, paddingHorizontal: 20, justifyContent: "center" },
  rowText: { color: colors.text, fontSize: typography.body.fontSize },
  custom: { paddingHorizontal: 16, paddingBottom: 8, gap: 10 },
  error: { color: colors.red, fontSize: typography.meta.fontSize },
  go: { backgroundColor: colors.accent, borderRadius: 12, minHeight: 48, alignItems: "center", justifyContent: "center" },
  goOff: { opacity: 0.5 },
  goText: { color: colors.onAccent, fontSize: typography.message.fontSize, fontWeight: weight.bold },
}));
