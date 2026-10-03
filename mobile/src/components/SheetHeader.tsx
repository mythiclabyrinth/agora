import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, space, typography } from "../lib/theme";

export function SheetHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return <View style={styles.root}>
    <View accessible={false} style={styles.handle} />
    <View style={styles.row}>
      <Text accessibilityRole="header" style={styles.title}>{title}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Close ${title.toLowerCase()}`}
        style={styles.close} onPress={onClose}><Text style={styles.label}>Cancel</Text></Pressable>
    </View>
  </View>;
}
const styles = StyleSheet.create({
  root: { gap: space.sm },
  handle: { width: 32, height: 4, borderRadius: 2, backgroundColor: colors.borderStrong, alignSelf: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm },
  title: { flex: 1, color: colors.text, fontSize: typography.title.fontSize, fontWeight: "600" },
  close: { minHeight: 44, minWidth: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: space.sm },
  label: { color: colors.a1, fontSize: typography.bodySm.fontSize },
});
