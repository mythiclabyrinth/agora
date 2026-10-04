import React from "react";
import { Pressable, View } from "react-native";
import { Monitor, Moon, Sun } from "lucide-react-native";
import { Icon } from "./Icon";
import { ResponsiveText as Text } from "./ResponsiveText";
import { usePrefs } from "../state/prefs";
import { createThemedStyles, useAppTheme } from "../lib/useTheme";
import { radii, space, typography, weight, type AppearancePreference } from "../lib/theme";

const options = [{ value: "light", label: "Light", icon: Sun }, { value: "dark", label: "Dark", icon: Moon }, { value: "system", label: "System", icon: Monitor }] as const;
export function AppearancePicker() {
  const preference = usePrefs(state => state.appearance);
  const setPreference = usePrefs(state => state.setAppearance);
  const { colors } = useAppTheme();
  const styles = useStyles();
  return <View style={styles.root}>
    <View accessibilityRole="radiogroup" accessibilityLabel="App appearance" style={styles.options}>
      {options.map(option => <Pressable key={option.value} accessibilityRole="radio" accessibilityLabel={`${option.label} theme`} accessibilityState={{ checked: preference === option.value }}
        style={[styles.option, preference === option.value && styles.selected]} onPress={() => setPreference(option.value as AppearancePreference)}>
        <Icon icon={option.icon} size={20} color={preference === option.value ? colors.a1 : colors.dim} />
        <Text style={[styles.label, preference === option.value && styles.selectedLabel]}>{option.label}</Text>
      </Pressable>)}
    </View>
    <Text style={styles.hint}>{preference === "system" ? "Follows your device appearance, including scheduled changes." : "Choose System to follow your device’s light or dark appearance."}</Text>
  </View>;
}
const useStyles = createThemedStyles(({ colors }) => ({
  root: { gap: space.md }, options: { flexDirection: "row", gap: space.sm },
  option: { flex: 1, minHeight: 76, gap: space.sm, padding: space.md, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radii.md, justifyContent: "center", alignItems: "center" },
  selected: { borderColor: colors.a1, backgroundColor: colors.accentSoft },
  label: { color: colors.dim, ...typography.bodySm, fontWeight: weight.semibold }, selectedLabel: { color: colors.a1 },
  hint: { color: colors.faint, ...typography.caption },
}));
