import React, { useRef, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Check, ChevronRight, Ellipsis, type LucideIcon } from "lucide-react-native";
import { IconButton } from "./IconButton";
import { Icon } from "./Icon";
import { SheetHeader } from "./SheetHeader";
import { ResponsiveText as Text } from "./ResponsiveText";
import { colors, radii, space, surfaces, typography } from "../lib/theme";

export type ConversationTool = { label: string; detail?: string; icon: LucideIcon; selected?: boolean; onPress: () => void };

export function ConversationTools({ title, actions }: { title: string; actions: ConversationTool[] }) {
  const [open, setOpen] = useState(false);
  const pending = useRef<(() => void) | null>(null);
  const finish = () => { const action = pending.current; pending.current = null; action?.(); };
  const choose = (action?: () => void) => {
    pending.current = action ?? null;
    setOpen(false);
    // iOS must finish dismissing this native modal before another can open.
    if (Platform.OS !== "ios") finish();
  };
  return <>
    <IconButton icon={Ellipsis} accessibilityLabel="Conversation options" onPress={() => setOpen(true)} />
    <Modal visible={open} transparent animationType="slide" onRequestClose={() => choose()} onDismiss={finish}>
      <Pressable accessible={false} style={styles.backdrop} onPress={() => choose()}>
        <Pressable accessibilityViewIsModal accessible={false} style={styles.sheet} onPress={event => event.stopPropagation()}>
          <SheetHeader title={title} onClose={() => choose()} />
          <ScrollView>
            {actions.map(action => <Pressable key={action.label} accessibilityRole="button"
              accessibilityLabel={action.label} accessibilityState={action.selected === undefined ? undefined : { selected: action.selected }}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]} onPress={() => choose(action.onPress)}>
              <View style={styles.icon}><Icon icon={action.icon} size={20} color={colors.accentText} /></View>
              <View style={styles.copy}><Text style={styles.label}>{action.label}</Text>
                {action.detail ? <Text style={styles.detail}>{action.detail}</Text> : null}</View>
              <Icon icon={action.selected ? Check : ChevronRight} size={17} color={action.selected ? colors.a2 : colors.faint} />
            </Pressable>)}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  </>;
}
const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.scrim },
  sheet: { ...surfaces.sheet, maxHeight: "85%" },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.md,
    minHeight: 60, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  icon: { width: 38, height: 38, borderRadius: radii.md, backgroundColor: colors.accentSoft, alignItems: "center", justifyContent: "center" },
  copy: { flex: 1, gap: 2 },
  label: { ...typography.message, color: colors.text },
  detail: { ...typography.caption, color: colors.dim },
  pressed: { backgroundColor: colors.panel },
});
