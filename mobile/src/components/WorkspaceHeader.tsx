import React from "react";
import { Image, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Bot, Search, Settings2 } from "lucide-react-native";
import { IconButton } from "./IconButton";
import { ResponsiveText as Text } from "./ResponsiveText";
import { brand, layout, radii, space, typography } from "../lib/theme";
import { createThemedStyles, useAppTheme } from "../lib/useTheme";

/** One 44pt toolbar below the safe area; room belongs to conversations. */
export function WorkspaceHeader() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  return <View style={{ paddingTop: insets.top, backgroundColor: colors.bg }}>
    <View style={styles.bar}>
      <View style={styles.brand}>
        <Image source={brand.logo} style={styles.logo} accessibilityIgnoresInvertColors />
        <Text accessibilityRole="header" numberOfLines={1} maxFontSizeMultiplier={1.3} style={styles.name}>{brand.name}</Text>
      </View>
      <IconButton icon={Search} accessibilityLabel="Search messages" onPress={() => router.push("/(app)/search")} />
      <View style={styles.tools}>
        <IconButton icon={Bot} accessibilityLabel="Agents" onPress={() => router.push("/(app)/agents")} />
        <IconButton icon={Settings2} accessibilityLabel="Settings" onPress={() => router.push("/(app)/settings")} />
      </View>
    </View>
  </View>;
}
const useStyles = createThemedStyles(({ colors }) => ({
  bar: { minHeight: 44, paddingHorizontal: layout.gutter, flexDirection: "row", alignItems: "center", gap: space.xs },
  brand: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.sm },
  logo: { width: 26, height: 26, borderRadius: radii.sm },
  name: { ...typography.title, fontSize: 21, color: colors.text, letterSpacing: -0.5, flexShrink: 1 },
  tools: { flexDirection: "row", backgroundColor: colors.panel, borderRadius: radii.md },
}));
