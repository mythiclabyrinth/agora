import React from "react";
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";
import ReanimatedSwipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import type { LucideIcon } from "lucide-react-native";
import { Icon } from "./Icon";
import { colors } from "../lib/theme";

export interface SwipeAction {
  name: string;
  label: string;
  icon: LucideIcon;
  color: string;
  onPress: () => void;
}

export interface SwipeRowController {
  opened: (row: SwipeableMethods) => void;
  closed: (row: SwipeableMethods) => void;
  close: () => void;
  consumeTap: () => boolean;
}

export function createSwipeRowController(): SwipeRowController {
  let open: SwipeableMethods | null = null;
  return {
    opened(row) {
      if (open && open !== row) open.close();
      open = row;
    },
    closed(row) { if (open === row) open = null; },
    close() { open?.close(); open = null; },
    consumeTap() {
      if (!open) return false;
      open.close();
      open = null;
      return true;
    },
  };
}

export function useSwipeRows(): SwipeRowController {
  const controller = React.useRef<SwipeRowController | null>(null);
  controller.current ??= createSwipeRowController();
  return controller.current;
}

export function SwipeRow({
  children, style, onPress, onLongPress, swipeLeft, swipeRight, controller,
  accessibilityLabel, initialOpen,
}: {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress: () => void;
  onLongPress?: () => void;
  swipeLeft?: SwipeAction;
  swipeRight?: SwipeAction;
  controller: SwipeRowController;
  accessibilityLabel: string;
  /** Opens the action in native Storybook previews. */
  initialOpen?: "left" | "right";
}) {
  const row = React.useRef<SwipeableMethods | null>(null);
  React.useEffect(() => {
    if (!initialOpen) return;
    const timer = setTimeout(() => {
      if (initialOpen === "left") row.current?.openRight();
      else row.current?.openLeft();
    }, 250);
    return () => clearTimeout(timer);
  }, [initialOpen]);
  const activate = (action: SwipeAction) => {
    controller.close();
    action.onPress();
  };
  const actionButton = (action: SwipeAction) => (
    <Pressable accessibilityRole="button" accessibilityLabel={action.label}
      style={[styles.action, { backgroundColor: action.color }]}
      onPress={() => activate(action)}>
      <Icon icon={action.icon} size={19} color={colors.onAccent} />
      <Text style={styles.actionText}>{action.label}</Text>
    </Pressable>
  );
  return <ReanimatedSwipeable ref={row} containerStyle={styles.container}
    overshootLeft={false} overshootRight={false}
    renderLeftActions={swipeRight ? () => actionButton(swipeRight) : undefined}
    renderRightActions={swipeLeft ? () => actionButton(swipeLeft) : undefined}
    onSwipeableWillOpen={() => { if (row.current) controller.opened(row.current); }}
    onSwipeableClose={() => { if (row.current) controller.closed(row.current); }}>
    <Pressable style={style} accessibilityRole="button" accessibilityLabel={accessibilityLabel}
      accessibilityActions={[swipeLeft, swipeRight].filter((action): action is SwipeAction => !!action)
        .map(action => ({ name: action.name, label: action.label }))}
      onAccessibilityAction={event => {
        const action = [swipeLeft, swipeRight].find(a => a?.name === event.nativeEvent.actionName);
        if (action) activate(action);
      }}
      onPress={() => { if (!controller.consumeTap()) onPress(); }}
      onLongPress={() => { controller.close(); onLongPress?.(); }}
      delayLongPress={350}>
      {children}
    </Pressable>
  </ReanimatedSwipeable>;
}

const styles = StyleSheet.create({
  container: { borderRadius: 13, overflow: "hidden" },
  action: { minWidth: 90, paddingHorizontal: 10, alignItems: "center", justifyContent: "center", gap: 4 },
  actionText: { color: colors.onAccent, fontWeight: "800", fontSize: 12 },
});
