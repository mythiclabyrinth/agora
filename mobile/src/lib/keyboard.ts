/* Keyboard helpers for the chat screens.

   iOS: expo-router 57 vendors react-navigation and no longer exposes
   useHeaderHeight, so the KeyboardAvoidingView offset is derived the same
   way the navigator does: status bar inset + the 44pt native-stack nav bar.

   Android: SDK 57 apps are always edge-to-edge (Android 16 makes it
   mandatory), and an edge-to-edge window is NOT resized for the IME even
   with `adjustResize` — the keyboard simply draws over the bottom of the
   screen. So the KeyboardAvoidingView has to pad here too. Its offset must be
   its parent's distance from the top of the window (status bar + header);
   the header is the platform `actionBarSize` (56dp on a phone in portrait,
   different on tablets/landscape), so it's measured rather than assumed.
   If a window ever does resize, the KAV's own frame shrinks with it and the
   computed padding falls to 0 — no double adjustment. */

import { useCallback, useEffect, useState } from "react";
import {
  Keyboard,
  Platform,
  type KeyboardAvoidingViewProps,
  type LayoutChangeEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const IOS_NAV_BAR_HEIGHT = 44;
/** Phone-portrait `actionBarSize`; only a fallback if measuring is impossible. */
const ANDROID_APP_BAR_HEIGHT = 56;

type HeaderKeyboardAvoiding = Pick<
  KeyboardAvoidingViewProps,
  "behavior" | "keyboardVerticalOffset" | "onLayout"
>;

/** Props for a KeyboardAvoidingView filling a screen under a native-stack
    header — spread them onto the KAV. `iosOffset` overrides the derived iOS
    offset for screens that predate it. */
export function useHeaderKeyboardAvoiding(iosOffset?: number): HeaderKeyboardAvoiding {
  const insets = useSafeAreaInsets();
  const [windowY, setWindowY] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    // KAV adds its own frame.y (parent-relative) to the keyboard overlap, so
    // the offset is the *parent's* window y — subtract it or it counts twice.
    const frameY = e.nativeEvent.layout.y;
    const target = e.target as { measureInWindow?: (cb: (x: number, y: number) => void) => void } | null;
    if (typeof target?.measureInWindow !== "function") {
      // An offset of 0 would silently re-hide the composer; estimate instead.
      if (__DEV__) console.warn("useHeaderKeyboardAvoiding: measureInWindow unavailable");
      setWindowY(insets.top + ANDROID_APP_BAR_HEIGHT);
      return;
    }
    target.measureInWindow((_x, y) => setWindowY(y - frameY));
  }, [insets.top]);
  if (Platform.OS === "ios") {
    return {
      behavior: "padding",
      keyboardVerticalOffset: iosOffset ?? insets.top + IOS_NAV_BAR_HEIGHT,
    };
  }
  if (Platform.OS === "android") {
    return { behavior: "padding", keyboardVerticalOffset: windowY, onLayout };
  }
  return {};
}

/** Whether the software keyboard is (about to be) on screen. */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const show = Keyboard.addListener(showEvent, () => setVisible(true));
    const hide = Keyboard.addListener(hideEvent, () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}
