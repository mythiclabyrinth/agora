import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Check, ChevronDown, ChevronUp } from "lucide-react-native";
import { Icon } from "./Icon";
import { colors } from "../lib/theme";

export type MembershipRole = "admin" | "member";

export function RoleDropdown({ value, onChange, disabled = false }: {
  value: MembershipRole;
  onChange: (role: MembershipRole) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return <View style={styles.root}>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Role: ${value}`}
      accessibilityState={{ expanded: open, disabled }}
      disabled={disabled}
      style={styles.trigger}
      onPress={() => setOpen(current => !current)}
    >
      <Text style={styles.triggerText}>{value === "admin" ? "Admin" : "Member"}</Text>
      <Icon icon={open ? ChevronUp : ChevronDown} size={13} color={colors.a1} />
    </Pressable>
    {open ? <View style={styles.menu}>
      {(["member", "admin"] as const).map(role => <Pressable
        key={role}
        accessibilityRole="menuitem"
        style={styles.option}
        onPress={() => { setOpen(false); if (role !== value) onChange(role); }}
      >
        <Text style={[styles.optionText, role === value && styles.selectedText]}>{role === "admin" ? "Admin" : "Member"}</Text>
        {role === value ? <Icon icon={Check} size={13} color={colors.a1} /> : null}
      </Pressable>)}
    </View> : null}
  </View>;
}

const styles = StyleSheet.create({
  root: { position: "relative", alignSelf: "flex-start" },
  trigger: { flexDirection: "row", alignItems: "center", gap: 5, minWidth: 88, justifyContent: "space-between", paddingVertical: 7, paddingHorizontal: 9, borderRadius: 8, borderWidth: 1, borderColor: "rgba(139,124,255,0.35)", backgroundColor: "rgba(139,124,255,0.12)" },
  triggerText: { color: colors.a1, fontSize: 12, fontWeight: "700" },
  menu: { marginTop: 4, minWidth: 116, padding: 4, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 9, backgroundColor: colors.sheet },
  option: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, paddingVertical: 8, paddingHorizontal: 9, borderRadius: 6 },
  optionText: { color: colors.text, fontSize: 12.5 }, selectedText: { color: colors.a1, fontWeight: "700" },
});
