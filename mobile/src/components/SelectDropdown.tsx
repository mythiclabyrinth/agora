import React, { useRef } from "react";
import { Pressable, ScrollView, Text, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import { Check, ChevronDown, ChevronUp } from "lucide-react-native";
import { Icon } from "./Icon";
import { AnchoredMenu } from "./AnchoredMenu";
import { typography, space } from "../lib/theme";
import { createThemedStyles, useAppTheme } from "../lib/useTheme";

export function SelectDropdown<T extends string>({
  label, value, options, open, openUpward = false, menuInSheet = false, inlineMenu = false, onLayout, onToggle, onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  open: boolean;
  openUpward?: boolean;
  menuInSheet?: boolean;
  /** @deprecated Menus now overlay forms without changing their height. */
  inlineMenu?: boolean;
  onLayout?: (event: LayoutChangeEvent) => void;
  onToggle: () => void;
  onChange: (value: T) => void;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const selected = options.find(option => option.value === value);
  const anchor = useRef<View>(null);
  return <View style={[styles.root, open && !menuInSheet && styles.rootOpen]} onLayout={onLayout}>
    <Text style={styles.label}>{label}</Text>
    <Pressable ref={anchor} accessibilityRole="button" accessibilityLabel={`${label}: ${selected?.label ?? ""}`}
      accessibilityState={{ expanded: open }} style={[styles.trigger, open && styles.triggerOpen]} onPress={onToggle}>
      <Text style={styles.triggerText} numberOfLines={1}>{selected?.label}</Text>
      <Icon icon={open ? ChevronUp : ChevronDown} size={17} color={colors.a1} />
    </Pressable>
    {open && !menuInSheet ? <AnchoredMenu anchor={anchor} label={label} onClose={onToggle} menuHeight={Math.min(220, options.length * 48 + 8)}>
      <SelectDropdownMenu value={value} options={options} onToggle={onToggle} onChange={onChange} style={styles.menuOverlay} />
    </AnchoredMenu> : null}
  </View>;
}

export function SelectDropdownMenu<T extends string>({ value, options, onToggle, onChange, style }: {
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onToggle: () => void;
  onChange: (value: T) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  return <ScrollView accessibilityRole="menu" style={[styles.menu, style]} nestedScrollEnabled keyboardShouldPersistTaps="handled">
      {options.map(option => <Pressable key={option.value} accessibilityRole="menuitem"
        accessibilityLabel={option.label}
        disabled={option.disabled}
        accessibilityState={{ selected: option.value === value, disabled: !!option.disabled }} style={[styles.option, option.value === value && styles.selectedOption, option.disabled && styles.disabledOption]}
        onPress={() => { if (option.disabled) return; if (option.value === value) onToggle(); else onChange(option.value); }}>
        <Text style={[styles.optionText, option.value === value && styles.selectedText]} numberOfLines={1}>
          {option.label}
        </Text>
        {option.value === value ? <Icon icon={Check} size={17} color={colors.a1} /> : null}
      </Pressable>)}
    </ScrollView>;
}

const useStyles = createThemedStyles(({ colors, surfaces }) => ({
  root: { gap: 6 },
  rootOpen: { zIndex: 10, elevation: 10 },
  label: { color: colors.dim, ...typography.meta },
  trigger: { ...surfaces.field, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md },
  triggerOpen: { borderColor: colors.a1, backgroundColor: colors.accentWash },
  selectedOption: { backgroundColor: colors.accentSoft },
  disabledOption: { opacity: 0.45 },
  triggerText: { color: colors.text, fontSize: 14, fontWeight: "600", flex: 1 },
  menu: { position: "absolute", left: 0, right: 0, maxHeight: 220, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 11, backgroundColor: colors.sheet, zIndex: 11, elevation: 11,
    shadowColor: "#000", shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 14 },
  menuOverlay: { position: "relative", borderWidth: 0, shadowOpacity: 0, elevation: 0 },
  option: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md, paddingHorizontal: space.md, paddingVertical: space.sm },
  optionText: { color: colors.dim, fontSize: 14, flex: 1 },
  selectedText: { color: colors.a1, fontWeight: "700" },
}));
