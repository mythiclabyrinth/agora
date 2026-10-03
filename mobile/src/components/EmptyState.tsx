import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { colors, control, radii, space, typography, weight } from "../lib/theme";
import { Icon } from "./Icon";

export function EmptyState({ icon, title, description, action }: {
  icon: LucideIcon; title: string; description?: string;
  action?: { label: string; accessibilityLabel?: string; onPress: () => void; disabled?: boolean };
}) {
  return <View style={styles.root}>
    <View accessible={false} style={styles.mark}><Icon icon={icon} size={24} color={colors.a1} /></View>
    <Text accessibilityRole="header" style={styles.title}>{title}</Text>
    {description ? <Text style={styles.description}>{description}</Text> : null}
    {action ? <Pressable accessibilityRole="button" disabled={action.disabled}
      accessibilityLabel={action.accessibilityLabel}
      accessibilityState={{ disabled: !!action.disabled }} onPress={action.onPress}
      style={({ pressed }) => [styles.action, pressed && styles.pressed, action.disabled && styles.disabled]}>
      <Text style={styles.actionText}>{action.label}</Text>
    </Pressable> : null}
  </View>;
}

const styles = StyleSheet.create({
  root: { alignItems: "center", padding: space.xxl, paddingVertical: space.section, gap: space.md },
  mark: { padding: space.lg, borderRadius: radii.lg, backgroundColor: colors.panelStrong },
  title: { ...typography.title, color: colors.text, textAlign: "center" },
  description: { ...typography.bodySm, color: colors.dim, textAlign: "center", maxWidth: 320 },
  action: { minHeight: control.minTouchSize, justifyContent: "center", paddingHorizontal: space.lg,
    paddingVertical: space.sm, borderRadius: radii.md, backgroundColor: colors.panelStrong },
  actionText: { ...typography.bodySm, fontWeight: weight.semibold, color: colors.a1, textAlign: "center" },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.5 },
});
