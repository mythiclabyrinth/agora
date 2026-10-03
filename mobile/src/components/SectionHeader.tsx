import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, space, typography } from "../lib/theme";

export function SectionHeader({ title, subtitle, action }: {
  title: string; subtitle?: string; action?: React.ReactNode;
}) {
  return <View style={styles.root}>
    <View style={styles.copy}>
      <Text accessibilityRole="header" style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
    {action}
  </View>;
}

const styles = StyleSheet.create({
  root: { flexDirection: "row", alignItems: "center", gap: space.md },
  copy: { flex: 1, gap: space.xs },
  title: { ...typography.title, color: colors.text },
  subtitle: { ...typography.bodySm, color: colors.dim },
});
