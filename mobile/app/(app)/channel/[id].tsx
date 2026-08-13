/* Channel view: inverted infinite list, "New" divider from the read marker,
   live typing/progress, mention-aware composer, pins/stars sheets, and
   long-press message actions (thread / star / pin). */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import {
  Headphones,
  Paperclip,
  Pin,
  Star,
  Users,
  Volume2,
} from "lucide-react-native";
import {
  flattenMessages,
  FEATURES,
  useChannelAgents,
  useGroups,
  useMarkRead,
  useMembers,
  useMe,
  useMessages,
  usePins,
  useSendMessage,
  useSeedActivity,
  useStars,
} from "@agora/core";
import { useSendVoice } from "../../../src/api/voice";
import type { Message, PinnedMessage, StarredMessage } from "@agora/core";
import { Composer, type MentionCandidate } from "../../../src/components/Composer";
import { EmojiPicker } from "../../../src/components/EmojiPicker";
import { Icon } from "../../../src/components/Icon";
import { ProgressBubbles, TypingRow } from "../../../src/components/LiveRows";
import { MessageItem } from "../../../src/components/MessageItem";
import { MessageActions } from "../../../src/components/MessageActions";
import { SectionRail, useSectionJump } from "../../../src/components/SectionRail";
import { ProfileSheet } from "../../../src/components/ProfileSheet";
import { useReactWith } from "../../../src/components/Reactions";
import { toastErr } from "../../../src/components/Toast";
import { onAgentMessage } from "../../../src/lib/agentBus";
import { fmtTs } from "@agora/core";
import { headerActions } from "../../../src/lib/headerItems";
import { useHeaderKeyboardOffset } from "../../../src/lib/keyboard";
import { enqueueSpeech, prepareSpeechAudio, stopSpeech } from "../../../src/lib/speech";
import { colors } from "../../../src/lib/theme";
import { useChannelLive } from "@agora/core";
import { usePrefs } from "../../../src/state/prefs";
import { useSession } from "../../../src/state/session";

type Row = { kind: "msg"; m: Message } | { kind: "divider" };
const MAX_DEEP_LINK_PAGES = 10;

function openThread(channelId: string, root: Message, channelName: string) {
  router.push({
    pathname: "/(app)/thread/[channelId]/[rootId]",
    params: { channelId, rootId: String(root.id), channelName },
  });
}

/* Pinned / starred overlays. */
function ListSheet<T extends Message>({
  title,
  items,
  emptyText,
  onPick,
  onClose,
  subtitle,
}: {
  title: string;
  items: T[];
  emptyText: string;
  onPick: (item: T) => void;
  onClose: () => void;
  subtitle: (item: T) => string;
}) {
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <View style={[styles.sheet, styles.listSheet]}>
          <Text style={styles.sheetTitle}>{title}</Text>
          <ScrollView>
            {items.length === 0 ? <Text style={styles.sheetEmpty}>{emptyText}</Text> : null}
            {items.map((item) => (
              <Pressable key={item.id} style={styles.sheetItem} onPress={() => onPick(item)}>
                <Text style={styles.sheetItemAuthor}>
                  {item.author_name || item.author_id} · {subtitle(item)}
                </Text>
                <Text style={styles.sheetItemText} numberOfLines={2}>
                  {item.text || "(attachment)"}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </Pressable>
    </Modal>
  );
}

export default function ChannelScreen() {
  const params = useLocalSearchParams<{
    id: string;
    name?: string;
    groupId?: string;
    messageId?: string;
  }>();
  const channelId = params.id;
  const me = useMe().data;
  const targetMessageId = params.messageId ? Number(params.messageId) : null;
  const session = useSession((s) => s.session)!;
  const keyboardOffset = useHeaderKeyboardOffset();

  const groups = useGroups();
  const channelMeta = useMemo(() => {
    for (const g of groups.data ?? []) {
      const c = g.channels.find((x) => x.id === channelId);
      if (c) return { channel: c, group: g };
    }
    return null;
  }, [groups.data, channelId]);
  const channelName = params.name || channelMeta?.channel.name || "channel";
  // Treat the visibility-scoped groups payload as authoritative. Even normal
  // in-app navigation waits for it so a crafted groupId cannot drive members
  // or admin UI for a channel owned by another group.
  const groupId = channelMeta?.group.id;
  const groupMismatch =
    !!params.groupId && !!channelMeta && params.groupId !== channelMeta.group.id;

  const messages = useMessages(channelId, null);
  const send = useSendMessage(channelId);
  const sendVoice = useSendVoice(channelId);
  const markRead = useMarkRead(channelId);
  const pins = usePins(channelId);
  const stars = useStars(channelId);
  const channelAgents = useChannelAgents(channelId);
  const members = useMembers(groupId === "__dms" ? "" : (groupId ?? ""));
  useSeedActivity(channelId);
  const { typing, progress } = useChannelLive(channelId, null);

  /* "New" divider: snapshot the marker once, when the channel opens. */
  const dividerAfter = useRef<number | null>(null);
  if (dividerAfter.current === null && channelMeta) {
    const { unread, last_read_id } = channelMeta.channel;
    dividerAfter.current = (unread ?? 0) > 0 ? (last_read_id ?? 0) : 0;
  }

  const chronological = useMemo(() => flattenMessages(messages.data), [messages.data]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const marker = dividerAfter.current ?? 0;
    for (const m of chronological) {
      if (marker > 0 && out.length > 0) {
        const prev = out[out.length - 1];
        if (prev.kind === "msg" && prev.m.id <= marker && m.id > marker) {
          out.push({ kind: "divider" });
        }
      }
      out.push({ kind: "msg", m });
    }
    return out;
  }, [chronological]);

  /* Read marker: while the viewer sits at the bottom, every newly-landed
     message is read. Debounced like the desktop's PUT /read. */
  const atBottom = useRef(true);
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestId = chronological.length ? chronological[chronological.length - 1].id : 0;
  const unread = channelMeta?.channel.unread ?? 0;
  useEffect(() => {
    if (!atBottom.current || latestId === 0) return;
    if (latestId <= (channelMeta?.channel.last_read_id ?? 0)) return;
    if (readTimer.current) clearTimeout(readTimer.current);
    readTimer.current = setTimeout(() => markRead.mutate(latestId), 600);
    return () => {
      if (readTimer.current) clearTimeout(readTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestId]);

  const listRef = useRef<FlashListRef<Row>>(null);
  const [showJump, setShowJump] = useState(false);
  const [highlightedId, setHighlightedId] = useState<number | null>(null);
  const landedOnMessage = useRef<number | null>(null);
  const {
    activeMessageId: activeSectionMessageId,
    onViewableItemsChanged,
    viewabilityConfig,
    jumpToSection,
    cancelSectionJump,
  } = useSectionJump({ listRef, rows, atBottom, latestId });

  /* A shared deep link may point well beyond the newest page. Page older
     history until the row exists, then center it. */
  useEffect(() => {
    if (!targetMessageId || landedOnMessage.current === targetMessageId) return;
    const idx = rows.findIndex((r) => r.kind === "msg" && r.m.id === targetMessageId);
    if (idx >= 0) {
      landedOnMessage.current = targetMessageId;
      cancelSectionJump();
      atBottom.current = false;
      setHighlightedId(targetMessageId);
      setTimeout(() => setHighlightedId(null), 1800);
      setTimeout(() => {
        listRef.current?.scrollToIndex({ index: idx, animated: false, viewPosition: 0.5 });
      }, 80);
      // FlashList v2 has no onScrollToIndexFailed callback. Repeat after its
      // measurement pass so heterogeneous message heights still land exactly.
      setTimeout(() => {
        listRef.current?.scrollToIndex({ index: idx, animated: false, viewPosition: 0.5 });
      }, 300);
    } else if (
      chronological.length &&
      chronological[0].id <= targetMessageId
    ) {
      landedOnMessage.current = targetMessageId;
    } else if ((messages.data?.pages.length || 0) >= MAX_DEEP_LINK_PAGES) {
      landedOnMessage.current = targetMessageId;
    } else if (messages.hasNextPage && !messages.isFetchingNextPage) {
      void messages.fetchNextPage();
    } else if (!messages.hasNextPage) {
      landedOnMessage.current = targetMessageId;
    }
  }, [
    targetMessageId, rows, chronological, messages.hasNextPage, messages.isFetchingNextPage,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Land on the "New" divider instead of the bottom when there's a backlog
     (Slack behavior) — once, on the first page load. */
  const landedOnDivider = useRef(false);
  useEffect(() => {
    if (targetMessageId || landedOnDivider.current || !rows.length) return;
    landedOnDivider.current = true;
    const idx = rows.findIndex((r) => r.kind === "divider");
    if (idx <= 0) return; // no divider (or it's at the very top already)
    // Give FlashList a frame to settle its bottom-anchored initial render.
    setTimeout(() => {
      listRef.current?.scrollToIndex({ index: idx, animated: false, viewPosition: 0.2 });
    }, 80);
  }, [rows, targetMessageId]);

  const agentCandidates = useMemo<MentionCandidate[]>(
    () => (channelAgents.data ?? []).map((a) => ({ id: a.id, name: a.name })),
    [channelAgents.data],
  );
  const mentionCandidates = useMemo<MentionCandidate[]>(() => {
    const people = (members.data ?? [])
      .filter((m) => m.member_type === "user")
      .map((m) => ({ id: m.member_id, name: m.member_id }));
    return [...agentCandidates, ...people];
  }, [agentCandidates, members.data]);

  const starredIds = useMemo(() => new Set((stars.data ?? []).map((s) => s.id)), [stars.data]);
  const pinnedIds = useMemo(() => new Set((pins.data ?? []).map((p) => p.id)), [pins.data]);

  const groupName = channelMeta?.group.name;
  const openMembers = useCallback(() => {
    if (!groupId) return;
    router.push({
      pathname: "/(app)/members/[groupId]",
      params: { groupId, name: groupName ?? "" },
    });
  }, [groupId, groupName]);

  /* Desktop's "no agents are listening" nudge: any member agent (group-wide
     or scoped to this channel) counts, even if it's currently offline. */
  const noAgents =
    channelAgents.isSuccess &&
    members.isSuccess &&
    (channelAgents.data ?? []).length === 0 &&
    !(members.data ?? []).some(
      (m) => m.member_type === "agent" && (!m.channel_id || m.channel_id === channelId),
    );

  const [actionsFor, setActionsFor] = useState<Message | null>(null);
  const [reactFor, setReactFor] = useState<Message | null>(null);
  const reactWith = useReactWith();
  const [profileFor, setProfileFor] = useState<Message | null>(null);
  const [sheet, setSheet] = useState<"pins" | "stars" | null>(null);

  /* Delete gating: the sender, or any group admin (the groups payload's
     `role` already folds in instance admins). */
  const username = useSession((s) => s.username);
  const groupAdmin = channelMeta?.group.role === "admin";
  const canDelete = (m: Message) =>
    groupAdmin || (m.author_type === "user" && username !== "" && m.author_id === username);

  /* 🔊 speak-aloud: while this channel is focused (and not covered by the
     live screen), agent replies landing here are read out via server TTS. */
  const voiceOk = useSession((s) => s.voiceOk);
  const speakAloud = usePrefs((s) => s.speakAloud);
  const setSpeakAloud = usePrefs((s) => s.setSpeakAloud);
  useFocusEffect(
    useCallback(() => {
      if (!voiceOk || !speakAloud) return;
      void prepareSpeechAudio();
      const off = onAgentMessage((m) => {
        if (m.channel_id === channelId) enqueueSpeech(session, m.id);
      });
      return () => {
        off();
        stopSpeech();
      };
    }, [voiceOk, speakAloud, channelId, session]),
  );

  const openLive = useCallback(() => {
    stopSpeech();
    router.push({
      pathname: "/(app)/live/[channelId]",
      params: { channelId, channelName },
    });
  }, [channelId, channelName]);

  const renderRow = useCallback(
    ({ item }: { item: Row }) => {
      if (item.kind === "divider") {
        return (
          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>New</Text>
            <View style={styles.dividerLine} />
          </View>
        );
      }
      return (
        <View style={highlightedId === item.m.id ? styles.deepLinkTarget : undefined}>
          <MessageItem
            session={session}
            message={item.m}
            starred={starredIds.has(item.m.id)}
            pinned={pinnedIds.has(item.m.id)}
            onOpenThread={(root) => openThread(channelId, root, channelName)}
            onLongPress={setActionsFor}
            onAvatarPress={setProfileFor}
          />
        </View>
      );
    },
    [session, starredIds, pinnedIds, channelId, channelName, highlightedId],
  );

  if (groupMismatch) {
    return (
      <View style={styles.root}>
        <Text style={styles.empty}>This channel doesn't belong to the linked group.</Text>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: `# ${channelName}`,
          headerShown: true,
          ...headerActions(
            <View style={styles.headerBtns}>
              <Pressable
                accessibilityLabel="Channel attachments"
                onPress={() => router.push({
                  pathname: "/(app)/attachments/[channelId]",
                  params: { channelId, channelName, groupId },
                })}
                hitSlop={8}
              >
                <Icon icon={Paperclip} size={20} color={colors.text} />
              </Pressable>
              {voiceOk ? (
                <Pressable
                  onPress={() => {
                    if (speakAloud) stopSpeech();
                    setSpeakAloud(!speakAloud);
                  }}
                  hitSlop={8}
                >
                  <View style={!speakAloud && styles.headerBtnOff}>
                    <Icon icon={Volume2} size={20} color={colors.text} />
                  </View>
                </Pressable>
              ) : null}
              {voiceOk ? (
                <Pressable onPress={openLive} hitSlop={8}>
                  <Icon icon={Headphones} size={20} color={colors.text} />
                </Pressable>
              ) : null}
              <Pressable onPress={() => setSheet("pins")} hitSlop={8}>
                <Icon icon={Pin} size={20} color={colors.text} />
              </Pressable>
              {FEATURES.stars ? <Pressable onPress={() => setSheet("stars")} hitSlop={8}>
                <Icon icon={Star} size={20} color={colors.text} />
              </Pressable> : null}
              {groupId && groupId !== "__dms" ? (
                <Pressable onPress={openMembers} hitSlop={8}>
                  <Icon icon={Users} size={20} color={colors.text} />
                </Pressable>
              ) : null}
            </View>,
          ),
        }}
      />
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={keyboardOffset}
      >
        {noAgents && groupId && groupId !== "__dms" ? (
          <Pressable style={styles.noAgents} onPress={openMembers}>
            <Text style={styles.noAgentsText}>
              No agents are listening in this channel yet — tap to add one under Members.
            </Text>
          </Pressable>
        ) : null}
        <View style={styles.listWrap}>
          <FlashList
          ref={listRef}
          data={rows}
          renderItem={renderRow}
          keyExtractor={(item) => (item.kind === "msg" ? String(item.m.id) : "divider")}
          // Chat layout: render anchored to the bottom, stick to it while
          // the viewer is at it, and keep the viewport stable when older
          // pages prepend at the top. The threshold is deliberately tight:
          // anything bigger lets an incoming message drag a viewer who has
          // just started scrolling up back down to the bottom.
          maintainVisibleContentPosition={{
            startRenderingFromBottom: true,
            autoscrollToBottomThreshold: 0.05,
          }}
          onStartReached={() => {
            if (messages.hasNextPage && !messages.isFetchingNextPage) void messages.fetchNextPage();
          }}
          onStartReachedThreshold={0.4}
          onScrollBeginDrag={cancelSectionJump}
          onScroll={(e) => {
            const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
            const near = contentOffset.y + layoutMeasurement.height >= contentSize.height - 60;
            atBottom.current = near;
            setShowJump(!near);
          }}
          scrollEventThrottle={64}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          // Mounted whenever older history exists, not just mid-fetch:
          // toggling it per fetch changes the content height at the top
          // right as the user scrolls up, which reads as a jump.
          ListHeaderComponent={
            messages.hasNextPage ? (
              <ActivityIndicator color={colors.dim} style={{ paddingVertical: 14 }} />
            ) : null
          }
          ListEmptyComponent={
            messages.isLoading ? (
              <ActivityIndicator color={colors.dim} style={{ paddingVertical: 40 }} />
            ) : (
              <Text style={styles.empty}>No messages yet.</Text>
            )
          }
          />
          <SectionRail
            messages={chronological}
            activeMessageId={activeSectionMessageId}
            onJump={jumpToSection}
            // Leaves the lower-right region free for the absolutely positioned
            // unread pill; typing/progress rows sit outside this list wrapper.
            // Their conditional height changes the clearance, and the rail and
            // pill overlap horizontally, so keep a deliberate vertical margin.
            bottomInset={120}
          />
        </View>
        {showJump && unread > 0 ? (
          <Pressable
            style={styles.jump}
            onPress={() => {
              cancelSectionJump();
              listRef.current?.scrollToEnd({ animated: true });
              markRead.mutate(null);
            }}
          >
            <Text style={styles.jumpText}>↓ {unread} new</Text>
          </Pressable>
        ) : null}
        <TypingRow typing={typing} />
        <ProgressBubbles progress={progress} />
        {channelMeta?.channel.kind === "agent_dm" && channelMeta.channel.dm_can_post === false ? (
          <Text style={styles.noAgentsText}>Your access was removed. This conversation is read-only.</Text>
        ) : <Composer
          key={channelId}
          placeholder={`Message # ${channelName}`}
          mentions={mentionCandidates}
          agents={agentCandidates}
          addressKey={channelId}
          groupId={groupId}
          maxFileMb={me?.max_file_mb}
          maxVideoMb={me?.max_video_mb}
          sending={send.isPending}
          threadToggle
          onSend={async ({ text, files, replyInThread }) => {
            await send.mutateAsync({ text, threadId: null, files, replyInThread });
          }}
          onSendVoice={
            voiceOk
              ? async (file, mentions) => {
                  await sendVoice.mutateAsync({ file, threadId: null, mentions });
                }
              : undefined
          }
        />}
      </KeyboardAvoidingView>
      {actionsFor ? (
        <MessageActions
          message={actionsFor}
          channelId={channelId}
          groupId={groupId}
          starred={starredIds.has(actionsFor.id)}
          pinned={pinnedIds.has(actionsFor.id)}
          canPin
          canEdit={actionsFor.author_type === "user" && username !== "" && actionsFor.author_id === username}
          canDelete={canDelete(actionsFor)}
          onThread={actionsFor.thread_id == null
            ? () => openThread(channelId, actionsFor, channelName)
            : undefined}
          onClose={() => setActionsFor(null)}
          onReact={() => {
            setReactFor(actionsFor);
            setActionsFor(null);
          }}
        />
      ) : null}
      <EmojiPicker
        visible={reactFor != null}
        onPick={(emoji) => {
          if (reactFor) reactWith(reactFor, emoji);
          setReactFor(null);
        }}
        onClose={() => setReactFor(null)}
      />
      {profileFor ? (
        <ProfileSheet message={profileFor} onClose={() => setProfileFor(null)} />
      ) : null}
      {sheet === "pins" ? (
        <ListSheet<PinnedMessage>
          title="Pinned threads"
          items={pins.data ?? []}
          emptyText="Nothing pinned in this channel."
          subtitle={(p) => `pinned ${fmtTs(p.pinned_at)}`}
          onClose={() => setSheet(null)}
          onPick={(p) => {
            setSheet(null);
            openThread(channelId, p, channelName);
          }}
        />
      ) : null}
      {FEATURES.stars && sheet === "stars" ? (
        <ListSheet<StarredMessage>
          title="Starred messages"
          items={stars.data ?? []}
          emptyText="You haven't starred anything here."
          subtitle={(s) => `starred ${fmtTs(s.starred_at)}`}
          onClose={() => setSheet(null)}
          onPick={(s) => {
            setSheet(null);
            // A starred reply opens its thread; a starred root opens its own.
            openThread(channelId, s.root ?? s, channelName);
          }}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  listWrap: { flex: 1, position: "relative" },
  // Five actions fit beside a short channel title at the 320pt compact width.
  headerBtns: { flexDirection: "row", gap: 12 },
  headerBtnOff: { opacity: 0.35 },
  deepLinkTarget: { backgroundColor: "rgba(139,124,255,0.16)", borderRadius: 8 },
  empty: { color: colors.dim, textAlign: "center", paddingVertical: 40 },
  noAgents: {
    backgroundColor: "rgba(251,191,36,0.08)",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(251,191,36,0.35)",
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  noAgentsText: { color: colors.amber, fontSize: 12.5, lineHeight: 17 },
  divider: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  dividerLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.red },
  dividerText: { color: colors.red, fontSize: 11.5, fontWeight: "800" },
  jump: {
    position: "absolute",
    right: 16,
    bottom: 130,
    backgroundColor: colors.accent,
    borderRadius: 18,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  jumpText: { color: colors.onAccent, fontSize: 12.5, fontWeight: "800" },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.sheet,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 16,
    gap: 4,
    paddingBottom: 34,
  },
  listSheet: { maxHeight: "70%" },
  sheetTitle: { color: colors.text, fontSize: 16, fontWeight: "800", marginBottom: 8 },
  sheetEmpty: { color: colors.dim, paddingVertical: 20, textAlign: "center" },
  sheetItem: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  sheetItemAuthor: { color: colors.a1, fontSize: 12, fontWeight: "700", marginBottom: 2 },
  sheetItemText: { color: colors.text, fontSize: 13.5 },
});
