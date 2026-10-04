import React from "react";
import { Pressable, Text, View } from "react-native";

import { createThemedStyles } from "../lib/useTheme";

export const SERVER_SETUP_GUIDE_URL =
  "https://tomjose92.github.io/agora/self-hosting/";

export function shouldShowServerSetupHelp(
  recentLoaded: boolean,
  recentServers: string[],
): boolean {
  return recentLoaded && recentServers.length === 0;
}

export function ServerSetupHelp({
  onOpenGuide,
}: {
  onOpenGuide: (url: string) => void;
}) {
  const styles = useStyles();
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Don&apos;t have a server yet?</Text>
      <Text style={styles.body}>
        Agora for mobile connects to a server run by you or your organization.
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Learn how to set up an Agora server"
        accessibilityHint="Opens the Agora self-hosting guide"
        style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
        onPress={() => onOpenGuide(SERVER_SETUP_GUIDE_URL)}
      >
        <Text style={styles.actionText}>Set up an Agora server</Text>
      </Pressable>
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => ({
  card: {
    backgroundColor: colors.panelStrong,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 10,
    padding: 14,
    gap: 7,
  },
  title: { color: colors.text, fontSize: 14, fontWeight: "700" },
  body: { color: colors.dim, fontSize: 13, lineHeight: 18 },
  action: { alignSelf: "flex-start", paddingVertical: 4 },
  actionPressed: { opacity: 0.65 },
  actionText: { color: colors.a1, fontSize: 13.5, fontWeight: "700" },
}));
