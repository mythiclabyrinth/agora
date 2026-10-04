import React, { useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Check, ChevronDown, ChevronUp } from "lucide-react-native";
import { Icon } from "./Icon";

import { createThemedStyles, useAppTheme } from "../lib/useTheme";
import { AnchoredMenu } from "./AnchoredMenu";

export type MembershipRole = "admin" | "member";

export function RoleDropdown({ value, onChange, label = "Role", disabled = false }: {
  value: MembershipRole;
  onChange: (role: MembershipRole) => void;
  label?: string;
  disabled?: boolean;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const anchor = useRef<View>(null);
  return <View style={styles.root}>
    <Pressable
      ref={anchor}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      accessibilityState={{ expanded: open, disabled }}
      style={styles.trigger}
      onPress={() => setOpen(current => !current)}
    >
      <Text style={styles.triggerText}>{value === "admin" ? "Admin" : "Member"}</Text>
      <Icon icon={open ? ChevronUp : ChevronDown} size={13} color={colors.a1} />
    </Pressable>
    {open ? <AnchoredMenu anchor={anchor} onClose={() => setOpen(false)} label={label} menuHeight={100}>
      {(["member", "admin"] as const).map(role => <Pressable
        key={role}
        accessibilityRole="menuitem"
        accessibilityState={{ selected: role === value }}
        style={[styles.option, role === value && styles.selectedOption]}
        onPress={() => { setOpen(false); if (role !== value) onChange(role); }}
      >
        <Text style={[styles.optionText, role === value && styles.selectedText]}>{role === "admin" ? "Admin" : "Member"}</Text>
        {role === value ? <Icon icon={Check} size={13} color={colors.a1} /> : null}
      </Pressable>)}
    </AnchoredMenu> : null}
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => ({
  root: { position: "relative", alignSelf: "flex-start" },
  trigger: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, minWidth: 96, justifyContent: "space-between", paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.accentBorder, backgroundColor: colors.accentSoft },
  triggerText: { color: colors.a1, fontSize: 12, fontWeight: "700" },
  option: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, paddingVertical: 8, paddingHorizontal: 9, borderRadius: 8 },
  selectedOption: { backgroundColor: colors.accentSoft },
  optionText: { color: colors.text, fontSize: 12.5 }, selectedText: { color: colors.a1, fontWeight: "700" },
}));
