import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, type PressableProps } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { colors, control, radii } from "../lib/theme";
import { Icon } from "./Icon";

type Props = Omit<PressableProps, "children" | "accessibilityLabel" | "accessibilityRole"> & {
  icon: LucideIcon;
  accessibilityLabel: string;
  selected?: boolean;
  busy?: boolean;
};

export function IconButton({ icon, accessibilityLabel, selected = false, busy = false,
  disabled, style, accessibilityState, ...props }: Props) {
  const unavailable = disabled || busy;
  return <Pressable {...props} accessibilityLabel={accessibilityLabel} accessibilityRole="button"
    accessibilityState={{ ...accessibilityState, selected, busy, disabled: !!unavailable }}
    disabled={unavailable} style={state => [styles.button, selected && styles.selected,
      state.pressed && styles.pressed, unavailable && styles.disabled,
      typeof style === "function" ? style(state) : style]}>
    {busy ? <ActivityIndicator color={colors.a1} /> :
      <Icon icon={icon} size={20} color={selected ? colors.a1 : colors.text} />}
  </Pressable>;
}

const styles = StyleSheet.create({
  button: { minWidth: control.minTouchSize, minHeight: control.minTouchSize,
    alignItems: "center", justifyContent: "center", borderRadius: radii.md },
  selected: { backgroundColor: colors.panelStrong },
  pressed: { backgroundColor: colors.panelStrong },
  disabled: { opacity: 0.5 },
});
