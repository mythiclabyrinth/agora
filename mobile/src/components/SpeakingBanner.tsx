/* Thin strip shown while a long-press Speak is talking, with a Stop button.
   The signed-in stack wraps every screen in SpeakingScreen, so the strip
   sits at the top of the screen's content: right under the native header
   (never over back or the title), or under the status bar on headerless
   screens. */

import React, { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { Square, Volume2 } from "lucide-react-native";
import { radii, space, typography } from "../lib/theme";
import { createThemedStyles, useAppTheme } from "../lib/useTheme";
import { stopNativeSpeech, useNativeSpeech } from "../lib/nativeSpeech";
import { Icon } from "./Icon";

/** `padTop`: the strip owns the status-bar inset (headerless screens). */
export function SpeakingBanner({ padTop = false }: { padTop?: boolean }) {
  const speaking = useNativeSpeech((s) => s.speaking);
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const styles = useStyles();
  if (!speaking) return null;
  return <View style={[styles.root, {
    paddingTop: padTop ? insets.top : 0, paddingLeft: insets.left, paddingRight: insets.right,
  }]}>
    <View style={styles.row}>
      <Icon icon={Volume2} size={15} color={colors.a1} />
      <Text style={styles.label} numberOfLines={1}>Speaking message…</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Stop speaking"
        hitSlop={8} style={styles.stop} onPress={stopNativeSpeech}>
        <Icon icon={Square} size={11} color={colors.text} fill={colors.text} />
        <Text style={styles.stopText}>Stop</Text>
      </Pressable>
    </View>
  </View>;
}

/** Stack `screenLayout` wrapper. The tree is the same whether or not the
    strip shows, so starting or stopping speech never remounts the screen
    (drafts, scroll position). On a headerless screen the strip takes the
    status-bar inset, so the screen below is told its top inset is spent. */
export function SpeakingScreen({ headerShown, children }: React.PropsWithChildren<{ headerShown: boolean }>) {
  const speaking = useNativeSpeech((s) => s.speaking);
  const insets = useSafeAreaInsets();
  const spent = speaking && !headerShown;
  const screenInsets = useMemo(() => spent ? { ...insets, top: 0 } : insets, [spent, insets]);
  return <View style={{ flex: 1 }}>
    <SpeakingBanner padTop={!headerShown} />
    <SafeAreaInsetsContext.Provider value={screenInsets}>{children}</SafeAreaInsetsContext.Provider>
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => ({
  root: { backgroundColor: colors.panelStrong, borderBottomWidth: 1, borderBottomColor: colors.border },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 32,
    paddingHorizontal: space.lg },
  label: { flex: 1, color: colors.text, fontSize: typography.bodySm.fontSize },
  stop: { flexDirection: "row", alignItems: "center", gap: space.xs, borderRadius: radii.pill,
    paddingHorizontal: space.md, paddingVertical: 3, backgroundColor: colors.border },
  stopText: { color: colors.text, fontSize: typography.bodySm.fontSize, fontWeight: "600" },
}));
