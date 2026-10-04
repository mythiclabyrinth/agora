import React from "react";
import { Text, View } from "react-native";

import { createThemedStyles } from "../lib/useTheme";

/** Binary agent presence, distinct from connection transport health. */
export function AgentStatus({ live }: { live: boolean }) {
  const styles = useStyles();
  const label = live ? "online" : "offline";
  return <View style={styles.root} accessible accessibilityLabel={label}>
    <View accessibilityElementsHidden style={[styles.dot, live ? styles.dotOnline : styles.dotOffline]} />
    <Text style={[styles.label, live ? styles.online : styles.offline]}>{label}</Text>
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => ({
  root: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotOnline: { backgroundColor: colors.green },
  dotOffline: { backgroundColor: colors.faint },
  label: { fontSize: 11.5 },
  online: { color: colors.green },
  offline: { color: colors.faint },
}));
