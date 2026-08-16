/* Thread view: the root message pinned at the top, replies below, and a
   composer that posts with thread_id (the server folds reply-to-reply back
   to the root, same as resolve_thread in server.rs).

   Upgraded to match the channel screen: FlashList with pagination and
   bottom anchoring, a root fallback fetch for threads opened from the inbox
   or a notification (whose root isn't in the loaded top-level window),
   per-thread read acking while the viewer sits at the bottom, long-press
   star, and user mentions in the composer. */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { Headphones, Paperclip, Volume2 } from "lucide-react-native";
import { useQueryClient } from "@tanstack/react-query";
import { keys } from "@agora/core";
import { useSendVoice } from "../../../../src/api/voice";
import {
  flattenMessages,
  useChannelAgents,
  useGroups,
  useMarkThreadRead,
  useMembers,
  useMe,
  useMessage,
  useMessages,
  useSendMessage,
  useStars,
} from "@agora/core";
import type { Message, ThreadRow } from "@agora/core";
import { Composer, type MentionCandidate } from "../../../../src/components/Composer";
import { EmojiPicker } from "../../../../src/components/EmojiPicker";
import { Icon } from "../../../../src/components/Icon";
import { ProgressBubbles, TypingRow } from "../../../../src/components/LiveRows";
import { MessageItem } from "../../../../src/components/MessageItem";
import { MessageActions } from "../../../../src/components/MessageActions";
import { SectionRail, useSectionJump } from "../../../../src/components/SectionRail";
import { ProfileSheet } from "../../../../src/components/ProfileSheet";
import { useReactWith } from "../../../../src/components/Reactions";
import { onAgentMessage } from "../../../../src/lib/agentBus";
import { headerActions } from "../../../../src/lib/headerItems";
import { useHeaderKeyboardOffset } from "../../../../src/lib/keyboard";
import {
  enqueueSpeech,
  prepareSpeechAudio,
  stopSpeech,
} from "../../../../src/lib/speech";
import { colors } from "../../../../src/lib/theme";
import { threadAddressKey } from "@agora/core";
import { useChannelLive } from "@agora/core";
import { usePrefs } from "../../../../src/state/prefs";
import { useSession } from "../../../../src/state/session";

type Row = { kind: "root"; m: Message } | { kind: "msg"; m: Message };
const MAX_DEEP_LINK_PAGES = 10;

export default function ThreadScreen() {
  const params = useLocalSearchParams<{
    channelId: string;
    rootId: string;
    channelName?: string;
    messageId?: string;
    groupId?: string;
  }>();
  const channelId = params.channelId;
  const me = useMe().data;
  const rootId = Number(params.rootId);
  const targetMessageId = params.messageId ? Number(params.messageId) : null;
  const session = useSession((s) => s.session)!;
  const keyboardOffset = useHeaderKeyboardOffset();
  const qc = useQueryClient();

  const replies = useMessages(channelId, rootId);
  const topLevel = useMessages(channelId, null);
  const send = useSendMessage(channelId);
  const sendVoice = useSendVoice(channelId);
  const voiceOk = useSession((s) => s.voiceOk);
  const channelAgents = useChannelAgents(channelId);
  const stars = useStars(channelId);
  const markThreadRead = useMarkThreadRead(rootId);
  const { typing, progress } = useChannelLive(channelId, rootId);

  const groups = useGroups();
  const { groupId, groupRole, resolvedChannelName, isDm } = useMemo(() => {
    for (const g of groups.data ?? []) {
      const c = g.channels.find((x) => x.id === channelId);
      if (c) {
        return {
          groupId: g.id,
          groupRole: g.role,
          resolvedChannelName: c.name,
          isDm: c.kind === "agent_dm",
        };
      }
    }
    return { groupId: null, groupRole: null, resolvedChannelName: null, isDm: false };
  }, [groups.data, channelId]);
  const members = useMembers(groupId ?? "");
  const channelName = params.channelName || resolvedChannelName;
  const groupMismatch = !!params.groupId && !!groupId && params.groupId !== groupId;

  /* Tapping the header title jumps to the thread's channel. `navigate`
     (not `push`) pops back to the channel screen when the thread was opened
     from it, instead of stacking a duplicate. */
  const openChannel = useCallback(() => {
    router.navigate({
      pathname: "/(app)/channel/[id]",
      params: { id: channelId, name: channelName ?? "", groupId: groupId ?? "" },
    });
  }, [channelId, channelName, groupId]);

  // The root usually sits in the already-loaded top-level page set; when it
  // doesn't (inbox / notification / old pin), fetch it directly.
  const cachedRoot = useMemo(
    () => flattenMessages(topLevel.data).find((m) => m.id === rootId) ?? null,
    [topLevel.data, rootId],
  );
  const fetchedRoot = useMessage(rootId, cachedRoot === null);
  const candidateRoot = cachedRoot ?? fetchedRoot.data ?? null;
  const root =
    candidateRoot?.channel_id === channelId && candidateRoot.thread_id == null
      ? candidateRoot
      : null;
  const rootUnavailable =
    fetchedRoot.isError ||
    (candidateRoot != null &&
      (candidateRoot.channel_id !== channelId || candidateRoot.thread_id != null));

  const thread = useMemo(() => flattenMessages(replies.data), [replies.data]);
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (root) out.push({ kind: "root", m: root });
    for (const m of thread) out.push({ kind: "msg", m });
    return out;
  }, [root, thread]);
  const sectionMessages = useMemo(() => root ? [root, ...thread] : thread, [root, thread]);

  /* Read acking: while the viewer sits at the bottom, new replies are read.
     Mirrors the channel screen's channel-marker debounce. */
  const atBottom = useRef(true);
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestId = thread.length ? thread[thread.length - 1].id : 0;
  useEffect(() => {
    if (!atBottom.current || latestId === 0) return;
    const row = qc
      .getQueryData<ThreadRow[]>(keys.threads)
      ?.find((t) => t.root.id === rootId);
    if (row && latestId <= row.last_read_id) return;
    if (readTimer.current) clearTimeout(readTimer.current);
    readTimer.current = setTimeout(() => markThreadRead.mutate(latestId), 600);
    return () => {
      if (readTimer.current) clearTimeout(readTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestId]);

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
  const [actionsFor, setActionsFor] = useState<Message | null>(null);
  const [reactFor, setReactFor] = useState<Message | null>(null);
  const reactWith = useReactWith();
  const [profileFor, setProfileFor] = useState<Message | null>(null);

  /* Delete gating: the sender, or any group admin (the groups payload's
     `role` already folds in instance admins). Deleting the root takes the
     whole thread, so the screen pops back to the channel. */
  const username = useSession((s) => s.username);
  const canDelete = (m: Message) =>
    groupRole === "admin" ||
    (m.author_type === "user" && username !== "" && m.author_id === username);
  /* 🔊 speak-aloud: while this thread is focused (and not covered by the
     live screen), agent replies landing in it are read out via server TTS —
     the thread-scoped mirror of the channel screen's effect. */
  const speakAloud = usePrefs((s) => s.speakAloud);
  const setSpeakAloud = usePrefs((s) => s.setSpeakAloud);
  useFocusEffect(
    useCallback(() => {
      if (!voiceOk || !speakAloud) return;
      void prepareSpeechAudio();
      const off = onAgentMessage((m) => {
        if (m.channel_id === channelId && m.thread_id === rootId) {
          enqueueSpeech(session, m.id);
        }
      });
      return () => {
        off();
        stopSpeech();
      };
    }, [voiceOk, speakAloud, channelId, rootId, session]),
  );

  /* 🎧 live voice scoped to this thread: turns post as replies here. */
  const openLive = useCallback(() => {
    stopSpeech();
    router.push({
      pathname: "/(app)/live/[channelId]",
      params: {
        channelId,
        channelName: params.channelName ?? "",
        rootId: String(rootId),
        rootSnippet: (root?.text ?? "").slice(0, 80),
      },
    });
  }, [channelId, params.channelName, rootId, root?.text]);

  const listRef = useRef<FlashListRef<Row>>(null);
  const {
    activeMessageId: activeSectionMessageId,
    onViewableItemsChanged,
    viewabilityConfig,
    jumpToSection,
    cancelSectionJump,
  } = useSectionJump({ listRef, rows, atBottom, latestId });
  const [highlightedId, setHighlightedId] = useState<number | null>(null);
  const landedOnMessage = useRef<number | null>(null);
  useEffect(() => {
    if (!targetMessageId || landedOnMessage.current === targetMessageId) return;
    const idx = rows.findIndex((row) => row.m.id === targetMessageId);
    if (idx >= 0) {
      landedOnMessage.current = targetMessageId;
      cancelSectionJump();
      atBottom.current = false;
      setHighlightedId(targetMessageId);
      setTimeout(() => setHighlightedId(null), 1800);
      setTimeout(() => {
        listRef.current?.scrollToIndex({ index: idx, animated: false, viewPosition: 0.5 });
      }, 80);
      setTimeout(() => {
        listRef.current?.scrollToIndex({ index: idx, animated: false, viewPosition: 0.5 });
      }, 300);
    } else if (thread.length && thread[0].id <= targetMessageId) {
      landedOnMessage.current = targetMessageId;
    } else if ((replies.data?.pages.length || 0) >= MAX_DEEP_LINK_PAGES) {
      landedOnMessage.current = targetMessageId;
    } else if (replies.hasNextPage && !replies.isFetchingNextPage) {
      void replies.fetchNextPage();
    } else if (!replies.hasNextPage) {
      landedOnMessage.current = targetMessageId;
    }
  }, [
    targetMessageId, rows, thread, replies.hasNextPage, replies.isFetchingNextPage,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  const renderRow = useCallback(
    ({ item }: { item: Row }) => (
      <View style={[
        item.kind === "root" ? styles.rootMsg : undefined,
        highlightedId === item.m.id ? styles.deepLinkTarget : undefined,
      ]}>
        <MessageItem
          session={session}
          message={item.m}
          starred={starredIds.has(item.m.id)}
          onLongPress={setActionsFor}
          onAvatarPress={setProfileFor}
        />
      </View>
    ),
    [session, starredIds, highlightedId],
  );

  if (groupMismatch) {
    return (
      <View style={styles.root}>
        <Text style={styles.empty}>This thread doesn't belong to the linked group.</Text>
      </View>
    );
  }
  if (rootUnavailable) {
    return (
      <View style={styles.root}>
        <Text style={styles.empty}>
          This thread doesn't exist here, or you don't have access to it.
        </Text>
      </View>
    );
  }
  const threadName = root?.alias?.trim() || "";

  return (
    <>
      <Stack.Screen
        options={{
          headerTitle: () =>
            channelName ? (
              <Pressable onPress={openChannel} hitSlop={6}>
                <View style={styles.headerTitleWrap}>
                  <Text style={styles.headerTitle}>Thread · <Text style={styles.headerChan}># {channelName}</Text></Text>
                  {threadName ? <Text numberOfLines={1} style={styles.headerThreadName}>{threadName}</Text> : null}
                </View>
              </Pressable>
            ) : (
              <Text style={styles.headerTitle}>Thread</Text>
            ),
          headerShown: true,
          ...headerActions(
            <View style={styles.headerBtns}>
              <Pressable
                accessibilityLabel="Thread attachments"
                onPress={() => router.push({
                  pathname: "/(app)/attachments/[channelId]",
                  params: { channelId, channelName, groupId, threadId: String(rootId), threadName },
                })}
                hitSlop={8}
              >
                <Icon icon={Paperclip} size={20} color={colors.text} />
              </Pressable>
              {voiceOk ? <>
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
                <Pressable onPress={openLive} hitSlop={8}>
                  <Icon icon={Headphones} size={20} color={colors.text} />
                </Pressable>
              </> : null}
            </View>,
          ),
        }}
      />
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={keyboardOffset}
      >
        <View style={styles.listWrap}>
          <FlashList
          ref={listRef}
          data={rows}
          renderItem={renderRow}
          keyExtractor={(item) =>
            item.kind === "root" ? `root-${item.m.id}` : String(item.m.id)
          }
          // Tight threshold for the same reason as the channel screen: a
          // wider band lets an incoming reply yank an upward-scrolling
          // viewer back to the bottom.
          maintainVisibleContentPosition={{
            startRenderingFromBottom: true,
            autoscrollToBottomThreshold: 0.05,
          }}
          onStartReached={() => {
            if (replies.hasNextPage && !replies.isFetchingNextPage) void replies.fetchNextPage();
          }}
          onStartReachedThreshold={0.4}
          onScrollBeginDrag={cancelSectionJump}
          onScroll={(e) => {
            const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
            atBottom.current =
              contentOffset.y + layoutMeasurement.height >= contentSize.height - 60;
          }}
          scrollEventThrottle={64}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          // Mounted whenever older history exists (see the channel screen).
          ListHeaderComponent={
            replies.hasNextPage ? (
              <ActivityIndicator color={colors.dim} style={{ paddingVertical: 14 }} />
            ) : null
          }
          ListEmptyComponent={
            replies.isLoading || (cachedRoot === null && fetchedRoot.isLoading) ? (
              <ActivityIndicator color={colors.dim} style={{ paddingVertical: 40 }} />
            ) : (
              <Text style={styles.empty}>No replies yet.</Text>
            )
          }
          />
          <SectionRail
            messages={sectionMessages}
            activeMessageId={activeSectionMessageId}
            onJump={jumpToSection}
          />
        </View>
        <TypingRow typing={typing} />
        <ProgressBubbles progress={progress} />
        <Composer
          key={threadAddressKey(channelId, rootId)}
          placeholder="Reply in thread"
          mentions={mentionCandidates}
          agents={agentCandidates}
          addressKey={threadAddressKey(channelId, rootId)}
          groupId={groupId ?? undefined}
          maxFileMb={me?.max_file_mb}
          maxVideoMb={me?.max_video_mb}
          sending={send.isPending}
          requireAgentToggle={!isDm}
          onSend={async ({ text, files, requireAgent }) => {
            await send.mutateAsync({ text, threadId: rootId, files, requireAgent });
          }}
          onSendVoice={
            voiceOk
              ? async (file, mentions) => {
                  await sendVoice.mutateAsync({ file, threadId: rootId, mentions });
                }
              : undefined
          }
        />
      </KeyboardAvoidingView>
      {actionsFor ? (
        <MessageActions
          message={actionsFor}
          channelId={channelId}
          groupId={groupId ?? undefined}
          starred={starredIds.has(actionsFor.id)}
          canPin={false}
          canEdit={actionsFor.author_type === "user" && username !== "" && actionsFor.author_id === username}
          canDelete={canDelete(actionsFor)}
          onDeleted={actionsFor.id === rootId ? () => router.back() : undefined}
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
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  listWrap: { flex: 1, position: "relative" },
  headerBtns: { flexDirection: "row", gap: 16 },
  headerBtnOff: { opacity: 0.35 },
  deepLinkTarget: { backgroundColor: "rgba(139,124,255,0.16)", borderRadius: 8 },
  headerTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  headerTitleWrap: { alignItems: "center", maxWidth: 230, gap: 2 },
  headerThreadName: { color: colors.dim, fontSize: 11.5, fontWeight: "500", maxWidth: 220 },
  headerChan: { color: colors.dim },
  rootMsg: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderStrong,
    paddingBottom: 8,
    marginBottom: 8,
    paddingTop: 8,
  },
  empty: { color: colors.dim, textAlign: "center", paddingVertical: 24 },
});
