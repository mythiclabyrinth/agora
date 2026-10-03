import { StyleSheet, Text, View } from "react-native";
import { fmtLastReply, fmtLastReplyFull, fmtRelative, validLastReplyTs } from "@agora/core";
import { colors, typography, weight } from "../lib/theme";

/** Relative activity time shown at the right of the thread's top row. */
export function ThreadRelativeTime({
  timestamp,
  replyCount,
  lastReplyTs,
}: {
  timestamp: number;
  replyCount: number;
  lastReplyTs?: number | null;
}) {
  const footerHasReplyTime = replyCount > 0 && validLastReplyTs(lastReplyTs);
  return (
    <Text
      style={styles.relative}
      accessibilityLabel={footerHasReplyTime ? undefined : fmtLastReplyFull(timestamp)}
    >
      {fmtRelative(timestamp)}
    </Text>
  );
}

/** Reply count and unread badge on the left, with the latest reply on the right. */
export function ThreadInboxFooter({
  replyCount,
  unread,
  lastReplyTs,
}: {
  replyCount: number;
  unread: number;
  lastReplyTs?: number | null;
}) {
  const lastReply = replyCount > 0 && validLastReplyTs(lastReplyTs)
    ? lastReplyTs : undefined;
  return (
    <View style={styles.footer} testID="thread-inbox-footer">
      <View style={styles.replyGroup}>
        <Text style={styles.replies}>
          {replyCount} {replyCount === 1 ? "reply" : "replies"}
        </Text>
        {unread > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{unread > 99 ? "99+" : unread}</Text>
          </View>
        ) : null}
      </View>
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
  relative: { color: colors.faint, fontSize: typography.caption.fontSize, lineHeight: 15 },
  footer: { flexDirection: "row", alignItems: "center", gap: 10 },
  replyGroup: { flexDirection: "row", alignItems: "center", gap: 10 },
  replies: { color: colors.faint, fontSize: typography.caption.fontSize },
  badge: {
    backgroundColor: colors.accentBorder,
    borderRadius: 9,
    minWidth: 20,
    paddingHorizontal: 5,
    paddingVertical: 1,
    alignItems: "center",
  },
  badgeText: { color: colors.text, fontSize: typography.caption.fontSize, fontWeight: weight.bold },
  lastReply: {
    color: colors.faint,
    fontSize: typography.caption.fontSize,
    lineHeight: typography.caption.lineHeight,
    marginLeft: "auto",
    flexShrink: 1,
    maxWidth: 180,
    textAlign: "right",
  },
});
