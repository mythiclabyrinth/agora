import React from "react";
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";
import ReanimatedSwipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import type { LucideIcon } from "lucide-react-native";
import { Icon } from "./Icon";

import { createThemedStyles, useAppTheme } from "../lib/useTheme";

export interface SwipeAction {
  name: string;
  label: string;
  icon: LucideIcon;
  color: string;
  onPress: () => void;
}

/** What the controller tracks per row: anything that can close it. */
export interface SwipeRowHandle { close: () => void }

export interface SwipeRowController {
  opened: (row: SwipeRowHandle) => void;
  closed: (row: SwipeRowHandle) => void;
  close: () => void;
  isOpen: (row: SwipeRowHandle) => boolean;
  consumeTap: () => boolean;
}

export function shouldIgnoreSwipeRelease(dragged: boolean, row: SwipeRowHandle,
  controller: SwipeRowController): boolean {
  return dragged && controller.isOpen(row);
}

export function createSwipeRowController(): SwipeRowController {
  let open: SwipeRowHandle | null = null;
  return {
    opened(row) {
      if (open && open !== row) open.close();
      open = row;
    },
    closed(row) { if (open === row) open = null; },
    close() { open?.close(); open = null; },
    isOpen(row) { return open === row; },
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
  const styles = useStyles();
  const row = React.useRef<SwipeableMethods | null>(null);
  // The content moves with the finger, so a swipe ends inside the Pressable and
  // would fire onPress, which closes the row it just opened. Drop that press.
  const dragged = React.useRef(false);
  const startDrag = () => { dragged.current = true; };
  // This row's identity for the controller. The library's handle can change
  // on every re-render, so a stable token (closing whatever handle is
  // current) keeps opened / closed / isOpen comparing the same object.
  const tokenRef = React.useRef<SwipeRowHandle | null>(null);
  tokenRef.current ??= { close: () => row.current?.close() };
  const token = tokenRef.current;
  // A row that unmounts while open (removed by a refresh, or an approvals
  // card dropping to one request) must not stay the controller's open row,
  // or the next tap anywhere in the list is swallowed closing it. Layout
  // cleanup runs in the same commit, leaving no window for that tap.
  React.useLayoutEffect(() => () => { if (controller.isOpen(token)) controller.closed(token); }, [controller, token]);
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
  // ReanimatedSwipeable stacks both action panels (absoluteFill) underneath
  // the row at all times; the row itself must be opaque to hide them.
  const radius = StyleSheet.flatten(style)?.borderRadius ?? DEFAULT_RADIUS;
  const actionButton = (action: SwipeAction) => (progress: SharedValue<number>) =>
    <SwipeActionButton action={action} progress={progress} onPress={() => activate(action)} />;
  return <ReanimatedSwipeable ref={row}
    containerStyle={[styles.container, { borderRadius: radius }]}
    childrenContainerStyle={[styles.foreground, { borderRadius: radius }]}
    overshootLeft={false} overshootRight={false}
    renderLeftActions={swipeRight ? actionButton(swipeRight) : undefined}
    renderRightActions={swipeLeft ? actionButton(swipeLeft) : undefined}
    onSwipeableOpenStartDrag={startDrag} onSwipeableCloseStartDrag={startDrag}
    // Opens arrive asynchronously: one landing after unmount (row cleared)
    // must not register a row that no longer exists.
    onSwipeableWillOpen={() => { if (row.current) controller.opened(token); }}
    onSwipeableClose={() => controller.closed(token)}>
    <Pressable style={style} accessibilityRole="button" accessibilityLabel={accessibilityLabel}
      accessibilityActions={[swipeLeft, swipeRight].filter((action): action is SwipeAction => !!action)
        .map(action => ({ name: action.name, label: action.label }))}
      onAccessibilityAction={event => {
        const action = [swipeLeft, swipeRight].find(a => a?.name === event.nativeEvent.actionName);
        if (action) activate(action);
      }}
      onPress={() => {
        const wasDragged = dragged.current;
        dragged.current = false;
        if (shouldIgnoreSwipeRelease(wasDragged, token, controller)) return;
        if (!controller.consumeTap()) onPress();
      }}
      onPressIn={() => { dragged.current = false; }}
      onLongPress={() => { controller.close(); onLongPress?.(); }}
      delayLongPress={350}>
      {children}
    </Pressable>
  </ReanimatedSwipeable>;
}

/** An action panel, kept invisible until its side starts being revealed so no
 * colour can bleed through the row's rounded, anti-aliased edges at rest. */
function SwipeActionButton({ action, progress, onPress }: {
  action: SwipeAction; progress: SharedValue<number>; onPress: () => void;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const revealed = useAnimatedStyle(() => ({ opacity: progress.value > 0 ? 1 : 0 }));
  return <Animated.View style={[styles.actionWrap, revealed]}
    accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <Pressable accessibilityRole="button" accessibilityLabel={action.label}
      style={[styles.action, { backgroundColor: action.color }]} onPress={onPress}>
      <Icon icon={action.icon} size={19} color={colors.onAccent} />
      <Text style={styles.actionText}>{action.label}</Text>
    </Pressable>
  </Animated.View>;
}

const DEFAULT_RADIUS = 13;

const useStyles = createThemedStyles(({ colors }) => ({
  container: { overflow: "hidden" },
  // Rows use the translucent `colors.panel` card; backing it with the screen
  // background keeps the same look while making the foreground opaque.
  foreground: { backgroundColor: colors.bg, overflow: "hidden" },
  actionWrap: { flexDirection: "row" },
  action: { minWidth: 90, paddingHorizontal: 10, alignItems: "center", justifyContent: "center", gap: 4 },
  actionText: { color: colors.onAccent, fontWeight: "800", fontSize: 12 },
}));
