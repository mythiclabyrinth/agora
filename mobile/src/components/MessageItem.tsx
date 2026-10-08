/* Chat bubbles, mirroring the desktop's agoBubble: your own messages sit on
   the right in an accent bubble; agents and other people sit on the left with
   an avatar and author line. */

import React from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Pin, Star } from "lucide-react-native";
import type { Session } from "@agora/core";
import { FEATURES } from "@agora/core";
import type { Message } from "@agora/core";
import { fmtLastReply, fmtLastReplyFull, fmtTs, validLastReplyTs } from "@agora/core";
import { typography, weight, radii, space } from "../lib/theme";
import { createThemedStyles, useAppTheme } from "../lib/useTheme";
import { useSession } from "../state/session";
import { tldrOf, useTldrView } from "@agora/core";
import { AgentAvatar } from "./AgentAvatar";
import { Attachments } from "./Attachments";
import { Icon } from "./Icon";
import { MdText } from "./MdText";
import { MessageForm } from "./MessageForm";
import { MessageTable } from "./MessageTable";
import { Reactions } from "./Reactions";
import { Sources, visibleText } from "./Sources";
import { Unfurls } from "./Unfurls";
import { ArtifactList } from "./MapArtifacts";
import { MessageOptions } from "./MessageOptions";

export function Avatar({ message }: { message: Message }) {
  const styles = useStyles();
  if (message.author_type === "agent") {
    return <AgentAvatar agentId={message.author_id} size={30} />;
  }
  const initial = (message.author_name ||
    message.author_id ||
    "?")[0].toUpperCase();
  return (
    <View style={styles.avatar}>
      <Text maxFontSizeMultiplier={1.2} style={styles.avatarInitial}>{initial}</Text>
    </View>
  );
}

/* A thread footer squeezed into a short bubble wrapped its meta column one
   word per line. Roots with replies get a floor wide enough for the count
   plus "Last reply at …"; named threads get a wider, still fixed, floor so a
   useful prefix of the name shows before it truncates. Clamped to what the
   bubble's maxWidth allows so narrow phones never overflow. */
const THREAD_MIN = 248;
const NAMED_THREAD_MIN = 300;

export function threadBubbleMinWidth(
  windowWidth: number,
  fontScale: number,
  { named, mine }: { named: boolean; mine: boolean },
): number {
  const floor = (named ? NAMED_THREAD_MIN : THREAD_MIN) * Math.min(Math.max(fontScale, 1), 1.2);
  // Row padding is 12 per side; other people's bubbles also share the row
  // with a 30pt avatar and an 8pt gap.
  const rowInner = windowWidth - 24;
  const available = rowInner * 0.86 - (mine ? 0 : 38);
  return Math.round(Math.max(0, Math.min(floor, available)));
}

export function MessageItem({
  session,
  message,
  onOpenThread,
  onLongPress,
  onAvatarPress,
  starred,
  pinned,
}: {
  session: Session;
  message: Message;
  onOpenThread?: (root: Message) => void;
  onLongPress?: (message: Message) => void;
  onAvatarPress?: (message: Message) => void;
  starred?: boolean;
  pinned?: boolean;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const username = useSession((s) => s.username);
  const mine =
    message.author_type === "user" &&
    username !== "" &&
    message.author_id === username;
  const tldr = tldrOf(message);
  const showTldr = useTldrView((s) => !!s.showing[message.id]) && tldr != null;
  const body = showTldr && tldr != null ? tldr : visibleText(message);

  const flags = (
    <>
      {pinned ? <Icon icon={Pin} size={11} color={colors.a1} /> : null}
      {FEATURES.stars && starred ? (
        <Icon icon={Star} size={11} color={colors.amber} fill={colors.amber} />
      ) : null}
      {showTldr ? <Text style={styles.tldrMark}>TL;DR</Text> : null}
    </>
  );

  const replies =
    onOpenThread && (message.reply_count ?? 0) > 0 ? (
      <Pressable onPress={() => onOpenThread(message)} hitSlop={6}>
        <Text style={styles.replies}>
          {message.reply_count}{" "}
          {message.reply_count === 1 ? "reply" : "replies"} →
        </Text>
      </Pressable>
    ) : null;

  /* A name distinguishes otherwise identical roots. The right column takes
     only the space left by the reply count and keeps the time below the name. */
  const threadName = (message.alias || "").trim();
  const threadFoot = replies ? (
    <View style={styles.threadFoot}>
      {replies}
      {threadName || validLastReplyTs(message.last_reply_ts) ? (
        <View style={styles.threadMeta}>
          {threadName ? (
            <Text style={styles.threadAlias} numberOfLines={1} maxFontSizeMultiplier={1.2}>
              {threadName}
            </Text>
          ) : null}
          {validLastReplyTs(message.last_reply_ts) ? (
            <Text style={styles.lastReply} numberOfLines={2} maxFontSizeMultiplier={1.2}
              accessibilityLabel={`Last reply at ${fmtLastReplyFull(message.last_reply_ts)}`}>
              Last reply at {fmtLastReply(message.last_reply_ts)}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  ) : null;
  const threadMinWidth = threadFoot
    ? { minWidth: threadBubbleMinWidth(windowWidth, fontScale, { named: !!threadName, mine }) }
    : null;

  /* Long-press-to-star must NOT come from a Pressable wrapping the bubble:
     on the iOS new architecture a parent Pressable steals the pan gesture
     from a nested horizontal ScrollView (facebook/react-native#56879), which
     made wide markdown tables unscrollable. Instead the text blocks carry
     onLongPress themselves (via MdText) and an absolute-fill backdrop behind
     the content catches long-presses on the bubble's padding and gaps — the
     table's ScrollView never has a Pressable ancestor. */
  const longPressed = React.useRef(false);
  const longPress = onLongPress ? () => {
    longPressed.current = true;
    onLongPress(message);
  } : undefined;
  const openThread = onOpenThread && message.id > 0 ? () => {
    // React Native may emit onPress when a long press is released. Options
    // and thread navigation are mutually exclusive gestures.
    if (longPressed.current) return;
    onOpenThread(message);
  } : undefined;
  const pressIn = longPress || openThread
    ? () => { longPressed.current = false; }
    : undefined;
  // Code-block and table bodies deliberately have no tap handler: wrapping
  // their horizontal ScrollViews in a Pressable steals the pan gesture.
  const pressBackdrop = longPress || openThread ? (
    <Pressable
      style={StyleSheet.absoluteFill}
      onPressIn={pressIn}
      onPress={openThread}
      onLongPress={longPress}
    />
  ) : null;

  if (mine) {
    return (
      <View style={[styles.row, styles.rowMine]}>
        <View style={[styles.bubble, styles.bubbleMine, threadMinWidth]}>
          {pressBackdrop}
          <MdText text={body} onPressIn={pressIn} onPress={openThread} onLongPress={longPress} />
          <ArtifactList artifacts={message.meta?.artifacts} />
          <Attachments
            session={session}
            attachments={message.attachments ?? []}
          />
          <Unfurls message={message} />
          <Sources message={message} />
          <MessageForm message={message} />
          <MessageTable message={message} />
          <MessageOptions message={message} />
          <Reactions message={message} />
          <View style={styles.foot}>
            {flags}
            <Text maxFontSizeMultiplier={1.3} style={styles.ts}>{message.meta?.edited_at ? "edited · " : ""}{fmtTs(message.ts)}</Text>
          </View>
          {threadFoot}
        </View>
      </View>
    );
  }

  /* The avatar sits outside the bubble, so wrapping it in a Pressable is
     safe from the gesture-stealing issue described above. */
  const avatar = onAvatarPress ? (
    <Pressable onPress={() => onAvatarPress(message)} hitSlop={6}>
      <Avatar message={message} />
    </Pressable>
  ) : (
    <Avatar message={message} />
  );

  return (
    <View style={styles.row}>
      {avatar}
      <View style={[styles.bubble, styles.bubbleOther, threadMinWidth]}>
        {pressBackdrop}
        <View style={styles.head}>
          <Text style={styles.author} numberOfLines={1}>
            {message.author_name || message.author_id}
            {message.author_type === "agent" ? (
              <Text style={styles.agentTag}> · agent</Text>
            ) : null}
          </Text>
          {flags}
          <Text maxFontSizeMultiplier={1.3} style={styles.ts}>{message.meta?.edited_at ? "edited · " : ""}{fmtTs(message.ts)}</Text>
        </View>
        <MdText text={body} onPressIn={pressIn} onPress={openThread} onLongPress={longPress} />
        <ArtifactList artifacts={message.meta?.artifacts} />
        <Attachments
          session={session}
          attachments={message.attachments ?? []}
        />
        <Unfurls message={message} />
        <Sources message={message} />
        <MessageForm message={message} />
        <MessageTable message={message} />
        <MessageOptions message={message} />
        <Reactions message={message} />
        {threadFoot}
      </View>
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => ({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: space.sm,
  },
  rowMine: { justifyContent: "flex-end" },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: radii.md,
    backgroundColor: colors.mintSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarInitial: { color: colors.a2, fontSize: typography.bodySm.fontSize, fontWeight: weight.bold },
  bubble: {
    maxWidth: "86%",
    borderRadius: radii.lg,
    paddingHorizontal: 13,
    paddingVertical: 11,
    gap: space.xs,
  },
  bubbleMine: {
    backgroundColor: colors.ownMessage,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    borderBottomRightRadius: 5,
  },
  bubbleOther: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderTopLeftRadius: 5,
    flexShrink: 1,
  },
  head: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 8, rowGap: 2 },
  foot: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 6,
    marginTop: 2,
  },
  author: {
    color: colors.text,
    fontSize: typography.meta.fontSize,
    fontWeight: weight.bold,
    flexShrink: 1,
  },
  agentTag: { color: colors.faint, fontSize: typography.caption.fontSize, fontWeight: weight.semibold },
  ts: { color: colors.faint, fontSize: typography.caption.fontSize },
  replies: {
    color: colors.a1,
    fontSize: typography.meta.fontSize,
    fontWeight: weight.semibold,
    marginTop: 4,
  },
  /* RN defaults flexShrink to 0: the count keeps its width, while the meta
     column yields on 320pt screens instead of widening the bubble. */
  threadFoot: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderStrong,
    marginTop: space.sm,
    paddingTop: space.xs,
  },
  threadMeta: {
    flex: 1,
    minWidth: 0,
    marginTop: 4,
    alignItems: "flex-end",
  },
  threadAlias: {
    color: colors.faint,
    fontSize: typography.caption.fontSize,
    fontWeight: weight.semibold,
    textAlign: "right",
    alignSelf: "stretch",
  },
  lastReply: {
    color: colors.faint,
    fontSize: typography.caption.fontSize,
    lineHeight: typography.caption.lineHeight,
    textAlign: "right",
    alignSelf: "stretch",
  },
  tldrMark: {
    color: colors.a1,
    fontSize: typography.caption.fontSize,
    fontWeight: weight.bold,
    letterSpacing: 0.4,
    backgroundColor: colors.accentSoft,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    overflow: "hidden",
  },
}));
