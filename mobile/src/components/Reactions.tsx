/* Reaction chips under a message bubble: one chip per emoji with a count,
   the caller's own reactions highlighted; tapping toggles. Rendered only
   when the message has reactions — adding the first one goes through the
   long-press sheet. */

import React, { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Smile } from "lucide-react-native";
import type { Message, Reaction, ReactionReactor } from "@agora/core";
import { useAgents, useToggleReaction, useUsers } from "@agora/core";
import {
  POSITIVE_REACTION_EMOJIS,
  recordPositiveEvent,
} from "../lib/storeReview";
import { colors } from "../lib/theme";
import { useSession } from "../state/session";
import { Icon } from "./Icon";
import { AgentAvatar } from "./AgentAvatar";
import { hasMine, legacyReactors, reactorNames } from "../lib/reactions";

export { hasMine, legacyReactors, reactorNames } from "../lib/reactions";

function maybeRecordPositiveReaction(message: Message, emoji: string, on: boolean) {
  if (!on) return;
  if (message.author_type !== "agent") return;
  if (!POSITIVE_REACTION_EMOJIS.has(emoji)) return;
  void recordPositiveEvent();
}

/** Returns react(message, emoji): adds the caller's reaction, or removes it
    when they already reacted with that emoji — picker taps are toggles. */
export function useReactWith() {
  const username = useSession((s) => s.username);
  const toggle = useToggleReaction();
  return (message: Message, emoji: string) => {
    const mine =
      username !== "" &&
      (message.reactions ?? []).some((r) => r.emoji === emoji && hasMine(r, username));
    const on = !mine;
    toggle.mutate(
      { message, emoji, on },
      { onSuccess: () => maybeRecordPositiveReaction(message, emoji, on) },
    );
  };
}

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "👀", "🙏"];

/** The common-few row for the long-press sheet, plus a "more" button that
    hands off to the full emoji picker. */
export function QuickReactions({
  message,
  onDone,
  onMore,
}: {
  message: Message;
  onDone: () => void;
  onMore: () => void;
}) {
  const username = useSession((s) => s.username);
  const react = useReactWith();
  return (
    <View style={styles.quickRow}>
      {QUICK_REACTIONS.map((emoji) => {
        const mine =
          username !== "" &&
          (message.reactions ?? []).some((r) => r.emoji === emoji && hasMine(r, username));
        return (
          <Pressable
            key={emoji}
            style={[styles.quick, mine && styles.chipMine]}
            onPress={() => {
              react(message, emoji);
              onDone();
            }}
          >
            <Text style={styles.quickEmoji}>{emoji}</Text>
          </Pressable>
        );
      })}
      <Pressable style={styles.quick} onPress={onMore}>
        <Icon icon={Smile} size={20} color={colors.dim} />
      </Pressable>
    </View>
  );
}

export function Reactions({ message }: { message: Message }) {
  const username = useSession((s) => s.username);
  const toggle = useToggleReaction();
  const list = message.reactions ?? [];
  const [selected, setSelected] = useState<Reaction | null>(null);
  if (list.length === 0) return null;
  return (
    <View style={styles.row}>
      {list.map((r) => {
        const isMine = username !== "" && hasMine(r, username);
        return (
          <Pressable
            key={r.emoji}
            style={[styles.chip, isMine && styles.chipMine]}
            onPress={() => {
              const on = !isMine;
              toggle.mutate(
                { message, emoji: r.emoji, on },
                {
                  onSuccess: () =>
                    maybeRecordPositiveReaction(message, r.emoji, on),
                },
              );
            }}
            onLongPress={() => setSelected(r)}
            accessibilityLabel={`${reactorNames(r).join(", ")} reacted with ${r.emoji}`}
            accessibilityHint="Tap to toggle your reaction. Long press to see everyone who reacted."
            disabled={toggle.isPending}
          >
            <Text style={styles.emoji}>{r.emoji}</Text>
            <Text style={[styles.count, isMine && styles.countMine]}>{r.users.length}</Text>
          </Pressable>
        );
      })}
      {selected ? (
        <ReactionDetailsSheet
          reactions={list}
          initialEmoji={selected.emoji}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </View>
  );
}

export function ReactionDetailsSheet({
  reactions,
  initialEmoji,
  onClose,
}: {
  reactions: Reaction[];
  initialEmoji: string;
  onClose: () => void;
}) {
  const [emoji, setEmoji] = useState(initialEmoji);
  const users = useUsers();
  const agents = useAgents();
  const reaction = reactions.find((r) => r.emoji === emoji) ?? reactions[0];
  const reactors = reaction ? legacyReactors(reaction) : [];
  const nameFor = (r: ReactionReactor) => r.type === "agent"
    ? agents.data?.find((a) => a.id === r.id)?.name || r.name
    : users.data?.find((u) => u.username === r.id)?.display_name || r.name;
  return <Modal transparent animationType="fade" onRequestClose={onClose}>
    <Pressable style={styles.backdrop} onPress={onClose}>
      <Pressable style={styles.sheet} accessibilityViewIsModal onPress={() => undefined}>
        <View style={styles.handle} />
        <View style={styles.tabBorder}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.tabs}
          >
            {reactions.map((r) => {
              const selected = r.emoji === reaction?.emoji;
              return (
                <Pressable
                  key={r.emoji}
                  style={[styles.tab, selected && styles.tabActive]}
                  onPress={() => setEmoji(r.emoji)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected }}
                >
                  <Text style={styles.tabText}>{r.emoji} {r.users.length}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
        <Text style={styles.title}>{reaction?.emoji} reactions</Text>
        <ScrollView style={styles.reactorList}>
          {reactors.map((r) => {
            const name = nameFor(r);
            return (
              <View key={`${r.type}:${r.id}`} style={styles.reactorRow}>
                {r.type === "agent" ? (
                  <AgentAvatar agentId={r.id} size={44} />
                ) : (
                  <View style={styles.personAvatar}>
                    <Text style={styles.personInitial}>{name[0]?.toUpperCase() || "?"}</Text>
                  </View>
                )}
                <View>
                  <Text style={styles.reactorName}>{name}</Text>
                  <Text style={styles.reactorKind}>
                    @{r.id} · {r.type === "agent" ? "agent" : "person"}
                  </Text>
                </View>
              </View>
            );
          })}
        </ScrollView>
      </Pressable>
    </Pressable>
  </Modal>;
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 4 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "rgba(255,255,255,0.05)",
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 999,
    paddingVertical: 2,
    paddingHorizontal: 8,
  },
  chipMine: {
    backgroundColor: "rgba(139,124,255,0.14)",
    borderColor: "rgba(139,124,255,0.5)",
  },
  emoji: { fontSize: 14 },
  count: { color: colors.dim, fontSize: 11.5, fontWeight: "700" },
  countMine: { color: "#cfc8ff" },
  quickRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    marginBottom: 6,
  },
  quick: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.05)",
  },
  quickEmoji: { fontSize: 22 },
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.55)" },
  sheet: { maxHeight: "72%", backgroundColor: colors.sheet, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 20, paddingBottom: 36 },
  handle: { alignSelf: "center", width: 42, height: 4, borderRadius: 2, backgroundColor: colors.borderStrong, marginBottom: 16 },
  tabBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  tabs: { flexDirection: "row", gap: 8 },
  tab: { paddingHorizontal: 18, paddingBottom: 12, borderBottomWidth: 2, borderBottomColor: "transparent" },
  tabActive: { borderBottomColor: colors.a1 },
  tabText: { color: colors.text, fontSize: 17 },
  title: { color: colors.text, fontSize: 16, fontWeight: "700", marginVertical: 18 },
  reactorList: { flexGrow: 0 },
  reactorRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 9 },
  personAvatar: { width: 44, height: 44, borderRadius: 13, backgroundColor: "rgba(139,124,255,0.15)", alignItems: "center", justifyContent: "center" },
  personInitial: { color: colors.a2, fontSize: 18, fontWeight: "700" },
  reactorName: { color: colors.text, fontSize: 17, fontWeight: "700" },
  reactorKind: { color: colors.dim, fontSize: 13, marginTop: 2 },
});
