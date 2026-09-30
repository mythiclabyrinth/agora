import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Check, ChevronDown, ChevronUp } from "lucide-react-native";
import { Icon } from "./Icon";
import { colors } from "../lib/theme";

export function SelectDropdown<T extends string>({
  label, value, options, open, onToggle, onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  open: boolean;
  onToggle: () => void;
  onChange: (value: T) => void;
}) {
  const selected = options.find(option => option.value === value);
  return <View style={styles.root}>
    <Text style={styles.label}>{label}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${selected?.label ?? ""}`}
      accessibilityState={{ expanded: open }} style={styles.trigger} onPress={onToggle}>
      <Text style={styles.triggerText} numberOfLines={1}>{selected?.label}</Text>
      <Icon icon={open ? ChevronUp : ChevronDown} size={17} color={colors.a1} />
    </Pressable>
    {open ? <ScrollView accessibilityRole="menu" style={styles.menu} nestedScrollEnabled keyboardShouldPersistTaps="handled">
      {options.map(option => <Pressable key={option.value} accessibilityRole="menuitem"
        accessibilityLabel={option.label}
        accessibilityState={{ selected: option.value === value }} style={styles.option}
        onPress={() => { if (option.value === value) onToggle(); else onChange(option.value); }}>
        <Text style={[styles.optionText, option.value === value && styles.selectedText]} numberOfLines={1}>
          {option.label}
        </Text>
        {option.value === value ? <Icon icon={Check} size={17} color={colors.a1} /> : null}
      </Pressable>)}
    </ScrollView> : null}
  </View>;
}

const styles = StyleSheet.create({
  root: { gap: 6 },
  label: { color: colors.faint, fontSize: 11, fontWeight: "800", letterSpacing: 0.8, textTransform: "uppercase" },
  trigger: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12,
    paddingHorizontal: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 11, backgroundColor: colors.panel },
  triggerText: { color: colors.text, fontSize: 14, fontWeight: "600", flex: 1 },
  menu: { maxHeight: 220, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 11, backgroundColor: colors.panel },
  option: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingHorizontal: 12 },
  optionText: { color: colors.dim, fontSize: 14, flex: 1 },
  selectedText: { color: colors.a1, fontWeight: "700" },
});
