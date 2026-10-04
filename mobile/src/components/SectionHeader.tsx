import { ResponsiveText as Text } from "./ResponsiveText";
import React from "react";
import { View } from "react-native";
import { space, typography } from "../lib/theme";
import { createThemedStyles } from "../lib/useTheme";

export function SectionHeader({ title, subtitle, action }: {
  title: string; subtitle?: string; action?: React.ReactNode;
}) {
  const styles = useStyles();
  return <View style={styles.root}>
    <View style={styles.copy}>
      <Text accessibilityRole="header" style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
    {action}
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => ({
  root: { flexDirection: "row", alignItems: "center", gap: space.md },
  copy: { flex: 1, gap: space.xs },
  title: { fontSize: typography.title.fontSize, fontWeight: typography.title.fontWeight, color: colors.text },
  subtitle: { fontSize: typography.bodySm.fontSize, fontWeight: typography.bodySm.fontWeight, color: colors.dim },
}));
