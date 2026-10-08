import React from "react";
import { Pressable, Text, View } from "react-native";
import { useSelectOption, type Message } from "@agora/core";
import { typography, weight } from "../lib/theme";
import { createThemedStyles } from "../lib/useTheme";
import { toastErr } from "./Toast";

export function MessageOptions({ message }: { message: Message }) {
  const styles = useStyles();
  const select = useSelectOption();
  const options = message.meta?.options;
  if (!options?.length) return null;
  const resolved = message.meta?.resolved;
  if (resolved) {
    const label = resolved.label ||
      options.find(option => option.id === resolved.option_id)?.label ||
      resolved.option_id || "Resolved";
    return <View style={styles.options}>
      <Text style={styles.optionResult}>{label}{resolved.by ? ` by ${resolved.by}` : ""}</Text>
    </View>;
  }
  return <View style={styles.options}>
    {options.map(option => <Pressable
      key={option.id}
      accessibilityRole="button"
      accessibilityState={{ disabled: select.isPending }}
      style={[
        styles.optionBtn,
        option.style === "primary" && styles.optionPrimary,
        option.style === "danger" && styles.optionDanger,
      ]}
      onPress={() => select.mutate({ messageId: message.id, optionId: option.id }, {
        onError: error => toastErr("Couldn't send choice", error),
      })}
      disabled={select.isPending}
    >
      <Text style={[
        styles.optionLabel,
        option.style === "primary" && styles.optionPrimaryLabel,
        option.style === "danger" && styles.optionDangerLabel,
      ]}>{option.label || option.id}</Text>
    </Pressable>)}
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => ({
  options: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  optionBtn: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panelStrong,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  optionPrimary: {
    backgroundColor: colors.successSoft,
    borderColor: colors.successBorder,
  },
  optionDanger: {
    backgroundColor: colors.dangerSoft,
    borderColor: colors.dangerBorder,
  },
  optionLabel: { color: colors.text, fontSize: typography.meta.fontSize, fontWeight: weight.semibold },
  optionPrimaryLabel: { color: colors.green },
  optionDangerLabel: { color: colors.red },
  optionResult: { color: colors.faint, fontSize: typography.caption.fontSize, fontWeight: weight.semibold },
}));
