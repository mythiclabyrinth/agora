/* Link previews (meta.unfurls): compact cards under the message text for
   URLs the server unfurled from the prose — they arrive on a
   message_update once fetched, and the ws reducer's merge re-renders the
   bubble. Tapping opens the in-app browser. */

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import type { Message } from "@agora/core";
import { openLink } from "../lib/openLink";

import { createThemedStyles } from "../lib/useTheme";
import { hostOf } from "./Sources";

export function Unfurls({ message }: { message: Message }) {
  const styles = useStyles();
  const unfurls = message.meta?.unfurls ?? [];
  if (!unfurls.length) return null;
  return (
    <View style={styles.list}>
      {unfurls.map((u, i) => (
        <Pressable key={i} style={styles.card} onPress={() => void openLink(u.url)}>
          <View style={styles.body}>
            <Text style={styles.site} numberOfLines={1}>
              {u.site || hostOf(u.url)}
            </Text>
            <Text style={styles.title} numberOfLines={2}>
              {u.title || u.url}
            </Text>
            {u.description ? (
              <Text style={styles.desc} numberOfLines={2}>
                {u.description}
              </Text>
            ) : null}
          </View>
          {u.image ? (
            <Image source={{ uri: u.image }} style={styles.thumb} contentFit="cover" transition={80} />
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => ({
  list: { gap: 8, marginTop: 8 },
  card: {
    flexDirection: "row",
    gap: 10,
    alignItems: "flex-start",
    padding: 10,
    borderLeftWidth: 3,
    borderLeftColor: colors.borderStrong,
    borderRadius: 6,
    backgroundColor: colors.accentWash,
  },
  body: { flex: 1, minWidth: 0, gap: 2 },
  site: { color: colors.faint, fontSize: 11 },
  title: { color: colors.text, fontSize: 13, fontWeight: "600", lineHeight: 18 },
  desc: { color: colors.dim, fontSize: 12, lineHeight: 17 },
  thumb: {
    width: 64,
    height: 64,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
}));
