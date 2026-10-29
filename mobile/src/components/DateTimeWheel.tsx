/* An iOS-style date-and-time wheel in plain React Native, for Android (iOS
   uses the native spinner, which already looks like this): four snapping
   columns — day, hour, minute, AM/PM — behind one highlighted band, rows
   fading and shrinking away from it. Screen readers adjust each column with
   swipe up/down (accessibilityRole "adjustable"). */

import React, { useEffect, useMemo, useRef } from "react";
import {
  Animated,
  ScrollView,
  View,
  type AccessibilityActionEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { runAtToWheel, WHEEL_DAYS, wheelDayLabel, wheelToRunAt, type WheelValue } from "@agora/core";
import { createThemedStyles } from "../lib/useTheme";

/** Row height in pt; five rows show, the middle one selected. */
export const WHEEL_ROW = 36;
const VISIBLE = 5;
const PAD = WHEEL_ROW * Math.floor(VISIBLE / 2);

const HOURS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));
const MERIDIEM = ["AM", "PM"];

function WheelColumn({ label, options, index, onIndex, flex, align = "center" }: {
  label: string;
  options: string[];
  index: number;
  onIndex: (i: number) => void;
  flex: number;
  align?: "center" | "flex-end";
}) {
  const styles = useStyles();
  const scrollY = useRef(new Animated.Value(index * WHEEL_ROW)).current;
  const ref = useRef<ScrollView>(null);
  // The row last settled on, so an outside change scrolls but our own doesn't.
  const settled = useRef(index);

  useEffect(() => {
    if (settled.current === index) return;
    settled.current = index;
    ref.current?.scrollTo({ y: index * WHEEL_ROW, animated: true });
  }, [index]);

  const land = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.min(options.length - 1, Math.max(0, Math.round(e.nativeEvent.contentOffset.y / WHEEL_ROW)));
    if (i === settled.current) return;
    settled.current = i;
    onIndex(i);
  };
  // Rows (and their interpolations) are built once per column, not on every
  // wheel change: the day column alone is 366 animated rows.
  const latest = useRef({ index, onIndex });
  latest.current = { index, onIndex };
  const rows = useMemo(() => options.map((text, i) => {
    const at = i * WHEEL_ROW;
    const range = [at - 3 * WHEEL_ROW, at, at + 3 * WHEEL_ROW];
    return (
      <Animated.Text key={i} numberOfLines={1}
        style={[styles.row, { textAlign: align === "center" ? "center" : "right" }, {
          opacity: scrollY.interpolate({ inputRange: range, outputRange: [0.15, 1, 0.15], extrapolate: "clamp" }),
          transform: [{ scale: scrollY.interpolate({ inputRange: range, outputRange: [0.75, 1, 0.75], extrapolate: "clamp" }) }],
        }]}
        onPress={() => { if (i !== latest.current.index) latest.current.onIndex(i); }}>
        {text}
      </Animated.Text>
    );
  }), [options, styles, align, scrollY]);
  const step = (delta: number) => {
    const i = Math.min(options.length - 1, Math.max(0, index + delta));
    if (i !== index) onIndex(i);
  };

  return (
    <View style={{ flex }} accessible accessibilityRole="adjustable" accessibilityLabel={label}
      accessibilityValue={{ text: options[index] }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(e: AccessibilityActionEvent) => step(e.nativeEvent.actionName === "increment" ? 1 : -1)}>
      <Animated.ScrollView
        ref={ref}
        testID={`wheel-${label}`}
        showsVerticalScrollIndicator={false}
        snapToInterval={WHEEL_ROW}
        decelerationRate="fast"
        nestedScrollEnabled
        contentOffset={{ x: 0, y: index * WHEEL_ROW }}
        contentContainerStyle={{ paddingVertical: PAD }}
        scrollEventThrottle={16}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: true })}
        onMomentumScrollEnd={land}
        onScrollEndDrag={(e) => {
          // A drag that ends without a fling has no momentum end to wait for.
          const v = e.nativeEvent.velocity?.y ?? 0;
          if (Math.abs(v) < 0.05) land(e);
        }}>
        {rows}
      </Animated.ScrollView>
    </View>
  );
}

/** The wheel for `value` (local time); every change reports the newly
    selected instant. Past picks are refused on submit, not here. */
export function DateTimeWheel({ value, onChange, nowMs }: {
  value: Date;
  onChange: (d: Date) => void;
  /** Pinned "today" for tests; defaults to when the wheel opened. */
  nowMs?: number;
}) {
  const styles = useStyles();
  const openedAt = useRef(nowMs ?? Date.now());
  const now = nowMs ?? openedAt.current;
  const v = runAtToWheel(Math.round(value.getTime() / 1000), now);
  const days = useMemo(() => Array.from({ length: WHEEL_DAYS }, (_, i) => wheelDayLabel(i, now)), [now]);
  const set = (patch: Partial<WheelValue>) => onChange(new Date(wheelToRunAt({ ...v, ...patch }, now) * 1000));
  return (
    <View style={styles.wheel} testID="schedule-wheel">
      <View style={styles.band} pointerEvents="none" />
      <WheelColumn label="Day" flex={2.3} align="flex-end" options={days} index={v.day} onIndex={(day) => set({ day })} />
      <WheelColumn label="Hour" flex={0.9} options={HOURS} index={v.hour12 - 1} onIndex={(i) => set({ hour12: i + 1 })} />
      <WheelColumn label="Minute" flex={0.9} options={MINUTES} index={v.minute} onIndex={(minute) => set({ minute })} />
      <WheelColumn label="AM or PM" flex={1} options={MERIDIEM} index={v.pm ? 1 : 0} onIndex={(i) => set({ pm: i === 1 })} />
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => ({
  wheel: { flexDirection: "row", height: WHEEL_ROW * VISIBLE, overflow: "hidden" },
  band: {
    position: "absolute", left: 0, right: 0, top: PAD, height: WHEEL_ROW,
    borderRadius: 10, backgroundColor: colors.neutralStrong,
  },
  row: { height: WHEEL_ROW, lineHeight: WHEEL_ROW, paddingHorizontal: 6, fontSize: 21, color: colors.text, fontVariant: ["tabular-nums"] },
}));
