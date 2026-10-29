import { SheetHeader } from "../../../src/components/SheetHeader";
import { previewText } from "../../../src/lib/previewText";
/* Channel view: inverted infinite list, "New" divider from the read marker,
   live typing/progress, mention-aware composer, pins/stars sheets, and
   long-press message actions (thread / star / pin). */

import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { Headphones } from "lucide-react-native";
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
  useCreateSchedule,
  useSchedulePresets,
  useSendMessage,
  useSeedActivity,
  useStars,
} from "@agora/core";
import { useSendVoice, useTranscribeVoice } from "../../../src/api/voice";
import type { Message, PinnedMessage, StarredMessage } from "@agora/core";
import { Composer, type MentionCandidate } from "../../../src/components/Composer";
import { EmojiPicker } from "../../../src/components/EmojiPicker";

import { ProgressBubbles, TypingRow } from "../../../src/components/LiveRows";
import { MessageItem } from "../../../src/components/MessageItem";
import { MessageActions } from "../../../src/components/MessageActions";
import { SectionRail } from "../../../src/components/SectionRail";
import { ProfileSheet } from "../../../src/components/ProfileSheet";
import { useReactWith } from "../../../src/components/Reactions";

import { onAgentMessage } from "../../../src/lib/agentBus";
import { fmtTs } from "@agora/core";
import { headerActions } from "../../../src/lib/headerItems";
import { useHeaderKeyboardAvoiding } from "../../../src/lib/keyboard";
import { useConversationList } from "../../../src/lib/useConversationList";
import { useDividerSnapshot } from "../../../src/lib/useDividerSnapshot";
import { newestLoadedId, parseMessageId, useMergeNewestPage } from "../../../src/lib/useMessageLanding";
import { enqueueSpeech, prepareSpeechAudio, stopSpeech } from "../../../src/lib/speech";
import { typography, weight } from "../../../src/lib/theme";
import { createThemedStyles, useAppTheme } from "../../../src/lib/useTheme";
import { useChannelLive } from "@agora/core";
import { channelRows, type ChannelRow } from "../../../src/lib/channelRows";
import { usePrefs } from "../../../src/state/prefs";
import { useSession } from "../../../src/state/session";
import { ConversationTools } from "../../../src/components/ConversationTools";
import { channelToolActions } from "../../../src/lib/conversationTools";
import { IconButton } from "../../../src/components/IconButton";

type Row = ChannelRow;

function openThread(channelId: string, root: Message, channelName: string) {
  router.push({
    pathname: "/(app)/thread/[channelId]/[rootId]",
    params: { channelId, rootId: String(root.thread_id ?? root.id), channelName },
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
  const styles = useStyles();
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <Pressable accessible={false} style={styles.sheetBackdrop} onPress={onClose}>
        <View accessibilityViewIsModal style={[styles.sheet, styles.listSheet]}>
          <SheetHeader title={title} onClose={onClose} />
          <ScrollView>
            {items.length === 0 ? <Text style={styles.sheetEmpty}>{emptyText}</Text> : null}
            {items.map((item) => (
              <Pressable key={item.id} style={styles.sheetItem} onPress={() => onPick(item)}>
                <Text style={styles.sheetItemAuthor}>
                  {item.author_name || item.author_id} · {subtitle(item)}
                </Text>
                <Text style={styles.sheetItemText} numberOfLines={2}>
                  {previewText(item.text) || "(attachment)"}
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
  const { colors } = useAppTheme();
  const styles = useStyles();
  const params = useLocalSearchParams<{
    id: string;
    name?: string;
    groupId?: string;
    messageId?: string;
    /** Set with messageId by an in-place notification tap (see LAND_NONCE_PARAM). */
    landAt?: string;
  }>();
  const channelId = params.id;
  const me = useMe().data;
  const targetMessageId = parseMessageId(params.messageId);
  const session = useSession((s) => s.session)!;
  const keyboardAvoiding = useHeaderKeyboardAvoiding();

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
  const mergeNewestPage = useMergeNewestPage(channelId, null);
  const send = useSendMessage(channelId);
  const createSchedule = useCreateSchedule();
  const schedulePresets = useSchedulePresets();
  const sendVoice = useSendVoice(channelId);
  const transcribeVoice = useTranscribeVoice(channelId);
  const markRead = useMarkRead(channelId);
  const pins = usePins(channelId);
  const stars = useStars(channelId);
  const channelAgents = useChannelAgents(channelId);
  const members = useMembers(groupId === "__dms" ? "" : (groupId ?? ""));
  useSeedActivity(channelId);
  const { typing, progress } = useChannelLive(channelId, null);

  /* "New" divider: snapshot the marker once, when the channel opens. The
     groups payload can land after the first page; while its first fetch is
     in flight (not a retry after it failed) the opening position isn't decided. */
  const { marker, dividerReady, onOpeningDecided } = useDividerSnapshot(
    channelMeta?.channel,
    groups,
  );

  const chronological = useMemo(() => flattenMessages(messages.data), [messages.data]);
  const newestId = useMemo(() => newestLoadedId(chronological), [chronological]);

  const { rows, firstUnread } = useMemo(() => channelRows(chronological, marker), [chronological, marker]);

  /* Read marker: the newest message is read when it lands while the viewer
     sits at the bottom, or when the viewer scrolls down to it later. */
  const latestId = chronological.length ? chronological[chronological.length - 1].id : 0;
  const unread = channelMeta?.channel.unread ?? 0;

  const listRef = useRef<FlashListRef<Row>>(null);
  const [showJump, setShowJump] = useState(false);
  const conversation = useConversationList({
    listRef,
    rows,
    latestId,
    target: targetMessageId,
    landingNonce: params.landAt,
    oldestId: chronological.length ? chronological[0].id : null,
    newestId,
    history: {
      loaded: messages.data !== undefined,
      pageCount: messages.data?.pages.length ?? 0,
      hasNextPage: messages.hasNextPage,
      isFetchingNextPage: messages.isFetchingNextPage,
      failed: messages.isFetchNextPageError,
      // The infinite-query observer's isRefetching already excludes
      // next/previous-page fetches.
      refreshing: messages.isRefetching,
      paused: messages.isPaused,
      fetchNextPage: () => void messages.fetchNextPage(),
      refetch: mergeNewestPage,
    },
    dividerReady,
    dividerMessageId: firstUnread?.id ?? null,
    onOpeningDecided,
    lastReadId: () => channelMeta?.channel.last_read_id,
    ack: (id, onError) => markRead.mutate(id, { onError }),
    onNearBottom: (near) => setShowJump(!near),
  });
  const highlightedId = conversation.highlightedId;

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
      params: { groupId, name: groupName ?? "", channelId },
    });
  }, [groupId, groupName, channelId]);

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
  const sttOk = useSession((s) => s.sttOk);
  const transcribeOk = useSession((s) => s.transcribeOk);
  const ttsOk = useSession((s) => s.ttsOk);
  const speakAloud = usePrefs((s) => s.speakAloud);
  const setSpeakAloud = usePrefs((s) => s.setSpeakAloud);
  useFocusEffect(
    useCallback(() => {
      if (!ttsOk || !speakAloud) return;
      void prepareSpeechAudio();
      const off = onAgentMessage((m) => {
        if (m.channel_id === channelId) enqueueSpeech(session, m.id);
      });
      return () => {
        off();
        stopSpeech();
      };
    }, [ttsOk, speakAloud, channelId, session]),
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
    [session, starredIds, pinnedIds, channelId, channelName, highlightedId, styles],
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
              {sttOk && ttsOk ? <IconButton icon={Headphones} accessibilityLabel="Start live voice" onPress={openLive} /> : null}
              <ConversationTools title={`# ${channelName}`} actions={channelToolActions({
                channelId, channelName, groupId, ttsOk, speakAloud,
                toggleSpeak: () => { if (speakAloud) stopSpeech(); setSpeakAloud(!speakAloud); },
                stars: FEATURES.stars, showMembers: !!groupId && groupId !== "__dms",
                onPins: () => setSheet("pins"), onStars: () => setSheet("stars"), onMembers: openMembers,
              })} />
            </View>,
          ),
        }}
      />
      <KeyboardAvoidingView
        style={styles.root}
        {...keyboardAvoiding}
      >
        {noAgents && groupId && groupId !== "__dms" ? (
          <Pressable style={styles.noAgents} onPress={openMembers}>
            <Text style={styles.noAgentsText}>
              No agents are listening in this channel yet — tap to add one under Participants.
            </Text>
          </Pressable>
        ) : null}
        <View style={styles.listWrap} onLayout={conversation.onViewportLayout}>
          <FlashList
          ref={listRef}
          data={rows}
          renderItem={renderRow}
          keyExtractor={(item) => (item.kind === "msg" ? String(item.m.id) : "divider")}
          {...conversation.listProps}
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
            activeMessageId={conversation.activeSectionMessageId}
            onJump={conversation.onRailJump}
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
              conversation.cancelJumps();
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
          onSend={async ({ text, files, replyInThread, draftRev, clientId }) => {
            return await send.mutateAsync({ text, threadId: null, files, replyInThread, draftRev, clientId });
          }}
          schedulePresets={schedulePresets}
          onSchedule={({ text, runAt }) => createSchedule.mutateAsync({ channelId, threadId: null, text, runAt })}
          onSendVoice={
            sttOk
              ? async (file, mentions) => {
                  await sendVoice.mutateAsync({ file, threadId: null, mentions });
                }
              : undefined
          }
          onTranscribeVoice={
            sttOk && transcribeOk
              ? async (file) => (await transcribeVoice.mutateAsync({ file, threadId: null })).text
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
          title="Pinned messages"
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

const useStyles = createThemedStyles(({ colors, surfaces }) => ({
  root: { flex: 1, backgroundColor: colors.bg },
  listWrap: { flex: 1, position: "relative" },
  headerBtns: { flexDirection: "row", gap: 4 },
  headerBtnOff: { opacity: 0.35 },
  deepLinkTarget: { backgroundColor: colors.accentSoft, borderRadius: 8 },
  empty: { color: colors.dim, textAlign: "center", paddingVertical: 40 },
  noAgents: {
    backgroundColor: colors.warningSoft,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.warningBorder,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  noAgentsText: { color: colors.amber, fontSize: typography.meta.fontSize, lineHeight: 17 },
  divider: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  dividerLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.red },
  dividerText: { color: colors.red, fontSize: typography.caption.fontSize, fontWeight: weight.bold },
  jump: {
    position: "absolute",
    right: 16,
    bottom: 130,
    backgroundColor: colors.accent,
    borderRadius: 18,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  jumpText: { color: colors.onAccent, fontSize: typography.meta.fontSize, fontWeight: weight.bold },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: colors.scrim,
    justifyContent: "flex-end",
  },
  sheet: {
    ...surfaces.sheet,
    gap: 4,
    paddingBottom: 34,
  },
  listSheet: { maxHeight: "70%" },
  sheetTitle: { color: colors.text, fontSize: typography.body.fontSize, fontWeight: weight.bold, marginBottom: 8 },
  sheetEmpty: { color: colors.dim, paddingVertical: 20, textAlign: "center" },
  sheetItem: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  sheetItemAuthor: { color: colors.a1, fontSize: typography.caption.fontSize, fontWeight: weight.bold, marginBottom: 2 },
  sheetItemText: { color: colors.text, fontSize: typography.bodySm.fontSize },
}));
