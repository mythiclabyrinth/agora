import React, { useEffect, useState } from "react";
import { Keyboard, Modal, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { radii, space } from "../lib/theme";
import { createThemedStyles } from "../lib/useTheme";

type Rect = { x: number; y: number; width: number; height: number };
export function menuPosition(anchor: Rect, width: number, height: number, menuHeight: number, minWidth = 160) {
  const menuWidth = Math.min(Math.max(minWidth, anchor.width), width - 32);
  const availableHeight = Math.max(0, Math.min(menuHeight, height - 64));
  const below = anchor.y + anchor.height + 6;
  const top = below + availableHeight <= height - 24 ? below : Math.max(24, Math.min(anchor.y - availableHeight - 6, height - availableHeight - 24));
  return { left: Math.max(16, Math.min(anchor.x, width - menuWidth - 16)), top, width: menuWidth, maxHeight: Math.min(availableHeight, height - top - 24) };
}

/** A native overlay escapes ancestor ScrollViews and auto-sized sheets. The
 * menu never participates in the trigger's layout or expands its parent. */
export function AnchoredMenu({ anchor, onClose, children, label, menuHeight = 200, minWidth = 160 }: {
  anchor: React.RefObject<View | null>; onClose: () => void; children: React.ReactNode;
  label: string; menuHeight?: number; minWidth?: number;
}) {
  const styles = useStyles();
  const { width, height, fontScale } = useWindowDimensions();
  const [rect, setRect] = useState<Rect | null>(null);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [keyboardTop, setKeyboardTop] = useState(height);
  const measure = () => anchor.current?.measureInWindow((x, y, measuredWidth, measuredHeight) =>
    setRect({ x, y, width: measuredWidth, height: measuredHeight }));
  useEffect(() => { measure(); }, [width, height]);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow", event => setKeyboardTop(event.endCoordinates.screenY));
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboardTop(height));
    return () => { show.remove(); hide.remove(); };
  }, [height]);
  const viewportHeight = Math.min(height, keyboardTop);
  const desiredHeight = Math.min(contentHeight ?? menuHeight * Math.max(1, fontScale), menuHeight * Math.max(1, fontScale));
  return <Modal transparent animationType="none" presentationStyle="overFullScreen"
    statusBarTranslucent navigationBarTranslucent onRequestClose={onClose} onShow={measure}>
    <View style={styles.overlay} accessibilityViewIsModal>
      <Pressable accessibilityRole="button" accessibilityLabel={`Dismiss ${label}`} style={StyleSheet.absoluteFill} onPress={onClose} />
      <View testID="anchored-menu" style={[styles.menu, rect ? menuPosition(rect, width, viewportHeight, desiredHeight, minWidth) : { opacity: 0 }]}>
        <ScrollView accessibilityRole="menu" accessibilityLabel={label} keyboardShouldPersistTaps="handled" bounces={false}
          onContentSizeChange={(_width, measuredHeight) => { setContentHeight(measuredHeight + 2 * space.xs + 2); measure(); }}>{children}</ScrollView>
      </View>
    </View>
  </Modal>;
}
const useStyles = createThemedStyles(({ colors }) => ({
  overlay: { flex: 1 },
  menu: { position: "absolute", borderRadius: radii.md, padding: space.xs, borderWidth: 1, borderColor: colors.borderStrong,
    backgroundColor: colors.sheet, shadowColor: colors.shadow, shadowOpacity: 0.3, shadowOffset: { width: 0, height: 6 }, shadowRadius: 14, elevation: 12 },
}));
