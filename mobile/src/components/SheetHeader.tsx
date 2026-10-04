import React from "react";
import { Pressable, Text, View } from "react-native";
import { radii, space, typography } from "../lib/theme";
import { createThemedStyles, useAppTheme } from "../lib/useTheme";
import { X } from "lucide-react-native";
import { Icon } from "./Icon";

export function SheetHeader({ title, onClose }: { title: string; onClose: () => void }) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  return <View style={styles.root}>
    <View accessible={false} style={styles.handle} />
    <View style={styles.row}>
      <Text accessibilityRole="header" style={styles.title}>{title}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Close ${title.toLowerCase()}`}
        style={styles.close} onPress={onClose}><Icon icon={X} size={19} color={colors.dim} /></Pressable>
    </View>
  </View>;
}
const useStyles = createThemedStyles(({ colors }) => ({
  root: { gap: space.md, paddingBottom: space.sm },
  handle: { width: 32, height: 4, borderRadius: 2, backgroundColor: colors.borderStrong, alignSelf: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm },
  title: { flex: 1, color: colors.text, fontSize: typography.title.fontSize, fontWeight: "600" },
  close: { minHeight: 44, minWidth: 44, borderRadius: radii.pill, backgroundColor: colors.panelStrong, alignItems: "center", justifyContent: "center", paddingHorizontal: space.sm },
  label: { color: colors.a1, fontSize: typography.bodySm.fontSize },
}));
