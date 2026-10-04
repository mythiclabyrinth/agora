/* Transient activity under the message list: agent typing rows and
   progress bubbles (one per handle, latest text wins — hub.rs keeps the
   map keyed by handle). */

import React, { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import type { ProgressEvent, TypingEvent } from "@agora/core";

import { createThemedStyles } from "../lib/useTheme";

function Blink({ children }: { children: React.ReactNode }) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.35, duration: 600, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return <Animated.View style={{ opacity }}>{children}</Animated.View>;
}

export function TypingRow({ typing }: { typing: TypingEvent[] }) {
  const styles = useStyles();
  if (typing.length === 0) return null;
  const names = typing.map((t) => t.agent_name).join(", ");
  return (
    <Blink>
      <Text style={styles.typing}>
        {names} {typing.length === 1 ? "is" : "are"} typing…
      </Text>
    </Blink>
  );
}

export function ProgressBubbles({ progress }: { progress: ProgressEvent[] }) {
  const styles = useStyles();
  if (progress.length === 0) return null;
  return (
    <View style={styles.progressWrap}>
      {progress.map((p) => (
        <View key={p.handle} style={styles.bubble}>
          <Text style={styles.bubbleAgent}>{p.agent_name}</Text>
          <Text style={styles.bubbleText} numberOfLines={3}>
            {p.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => ({
  typing: { color: colors.dim, fontSize: 12.5, paddingHorizontal: 16, paddingVertical: 4 },
  progressWrap: { gap: 6, paddingHorizontal: 16, paddingVertical: 4 },
  bubble: {
    backgroundColor: colors.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 8,
  },
  bubbleAgent: { color: colors.a1, fontSize: 11.5, fontWeight: "700", marginBottom: 2 },
  bubbleText: { color: colors.dim, fontSize: 12.5 },
}));
