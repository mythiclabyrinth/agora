import { StyleSheet, Text, View } from "react-native";
import { fmtLastReply, fmtLastReplyFull, fmtRelative, validLastReplyTs } from "@agora/core";
import { colors } from "../lib/theme";

export function ThreadTimeMeta({
  relativeTs,
  lastReplyTs,
  replyCount,
}: {
  relativeTs: number;
  lastReplyTs?: number | null;
  replyCount: number;
}) {
  const lastReply = replyCount > 0 && validLastReplyTs(lastReplyTs)
    ? lastReplyTs : undefined;
  return (
    <View style={styles.stack}>
      <Text style={styles.relative}>{fmtRelative(relativeTs)}</Text>
      {lastReply !== undefined && (
        <Text
          style={styles.lastReply}
          numberOfLines={1}
          maxFontSizeMultiplier={1.2}
          accessibilityLabel={`Last reply at ${fmtLastReplyFull(lastReply)}`}
        >
          Last reply at {fmtLastReply(lastReply, Date.now(), { compact: true })}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { alignItems: "flex-end", flexShrink: 1, maxWidth: 180 },
  relative: { color: colors.faint, fontSize: 11, lineHeight: 15 },
  lastReply: { color: colors.faint, fontSize: 9.5, lineHeight: 12 },
});
