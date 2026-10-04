/* Header items without the iOS 26 Liquid Glass capsule.

   On iOS 26 the native stack wraps header items (the back button and
   `headerRight` content) in system glass capsules that are re-created on
   every push/pop and composite their first frame with the DEFAULT (light)
   material — a white flash on every navigation in dark mode
   (react-native-screens#4163) — and the back capsule stays light glass even
   at rest. Rendering the same content through `unstable_headerLeftItems` /
   `unstable_headerRightItems` as `custom` items with `hidesSharedBackground`
   skips the capsules entirely. Other platforms keep the stock header. */

import React, { type ReactElement } from "react";
import { Platform, Pressable } from "react-native";
import { router, type NativeStackNavigationOptions } from "expo-router";
import { ChevronLeft } from "lucide-react-native";
import { Icon } from "../components/Icon";

import { useAppTheme } from "./useTheme";

export function headerActions(element: ReactElement | null): NativeStackNavigationOptions {
  if (Platform.OS !== "ios") {
    return { headerRight: () => element };
  }
  return {
    unstable_headerRightItems: () =>
      element ? [{ type: "custom", element, hidesSharedBackground: true }] : [],
  };
}

/* Chevron-only back button; renders nothing on the stack root. The edge
   swipe-back gesture is unaffected by hiding the native button. */
function HeaderBack() {
  const { colors } = useAppTheme();
  if (!router.canGoBack()) return null;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={12} style={{ paddingRight: 6 }}>
      <Icon icon={ChevronLeft} size={26} color={colors.text} strokeWidth={2.2} />
    </Pressable>
  );
}

export function headerBack(): NativeStackNavigationOptions {
  if (Platform.OS !== "ios") return {};
  return {
    headerBackVisible: false,
    unstable_headerLeftItems: () => [
      { type: "custom", element: <HeaderBack />, hidesSharedBackground: true },
    ],
  };
}
