/* Two-step destructive action, ported from the desktop: first tap arms
   ("Sure?"), a second tap within 5s executes, otherwise it disarms. */

import React, { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, type ViewStyle } from "react-native";
import { colors } from "../lib/theme";

export function ArmedButton({
  label,
  armedLabel = "Sure?",
  onConfirm,
  style,
  accessibilityLabel,
  compact = false,
}: {
  label: string;
  armedLabel?: string;
  onConfirm: () => void;
  style?: ViewStyle;
  accessibilityLabel?: string;
  /** Visually smaller; keeps a ~44pt touch target via hitSlop. */
  compact?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const press = () => {
    if (armed) {
      if (timer.current) clearTimeout(timer.current);
      setArmed(false);
      onConfirm();
      return;
    }
    setArmed(true);
    timer.current = setTimeout(() => setArmed(false), 5000);
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        armed
          ? `Confirm: ${accessibilityLabel ?? label}`
          : (accessibilityLabel ?? label)
      }
      accessibilityHint={
        armed ? "Activate again within five seconds to confirm" : undefined
      }
      onPress={press}
      hitSlop={compact ? { top: 10, bottom: 10, left: 8, right: 8 } : undefined}
      style={[styles.btn, compact && styles.compact, armed && styles.armed, style]}
    >
      <Text style={[styles.text, compact && styles.compactText]}>{armed ? armedLabel : label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    minHeight: 44,
    justifyContent: "center",
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(248,113,113,0.35)",
  },
  compact: {
    minHeight: 0,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
    flexShrink: 0,
    alignSelf: "flex-start",
  },
  armed: { backgroundColor: "rgba(248,113,113,0.16)", borderColor: colors.red },
  text: { color: colors.red, fontSize: 12.5, fontWeight: "600" },
  compactText: { fontSize: 11.5 },
});
