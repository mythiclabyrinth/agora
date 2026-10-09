import { previewText } from "../../src/lib/previewText";
import { ResponsiveText as Text } from "../../src/components/ResponsiveText";
import React from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { Check, CheckCheck, Hash, MessageSquare, Trash2 } from "lucide-react-native";
import { draftKey, draftSync, filterUnreads, fmtRelative, formatUnreadCount, useApprovals, useMarkUnreadsRead, useMe, useMessageDrafts, useSyncedDrafts, useUnreads, type ApprovalItem, type DraftRow, type UnreadItem } from "@agora/core";
import { EmptyState } from "../../src/components/EmptyState";
import { colors, typography, space, radii, weight, type Palette } from "../../src/lib/theme";
import { createThemedStyles, useAppTheme } from "../../src/lib/useTheme";
import { toast, toastErr } from "../../src/components/Toast";
import { SwipeRow, useSwipeRows, type SwipeAction, type SwipeRowController } from "../../src/components/SwipeRow";
import { ThreadsScreen } from "./threads";
import { Icon } from "../../src/components/Icon";
import { MessageOptions } from "../../src/components/MessageOptions";
import { layout } from "../../src/lib/theme";
import { useInboxTab, type InboxTab } from "../../src/state/inboxTab";

export function unreadSwipeAction(item: UnreadItem, onRead: (item: UnreadItem) => void, palette: Palette = colors): SwipeAction {
  return { name: "markRead", label: "Mark read", icon: Check, color: palette.a1,
    onPress: () => onRead(item) };
}

export function UnreadRow({ item, onRead, controller, initialSwipe }: {
  item: UnreadItem; onRead: (item: UnreadItem) => void;
  controller: SwipeRowController; initialSwipe?: "left";
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const open = () => {
    if (item.thread_id != null) {
      router.push({ pathname: "/(app)/thread/[channelId]/[rootId]", params: {
        channelId: item.channel_id, rootId: String(item.thread_id), messageId: String(item.first_unread_id),
        groupId: item.group_id, channelName: item.channel_name,
      } });
    } else {
      router.push({ pathname: "/(app)/channel/[id]", params: {
        id: item.channel_id, groupId: item.group_id, messageId: String(item.first_unread_id),
      } });
    }
  };
  return <SwipeRow style={styles.card} onPress={open} controller={controller} initialOpen={initialSwipe}
    accessibilityLabel={`Unread ${item.kind} in ${item.channel_name}, ${item.unread >= 100 ? "more than 99" : item.unread} messages`}
    swipeLeft={unreadSwipeAction(item, onRead, colors)}
    onLongPress={() => Alert.alert("Mark read", `Mark ${item.kind} read?`, [
      { text: "Open", onPress: open },
      { text: "Mark read", onPress: () => onRead(item) },
      { text: "Cancel", style: "cancel" },
    ])}>
    <View style={styles.cardTop}>
      <View style={styles.sourceIcon}><Icon icon={item.kind === "thread" ? MessageSquare : Hash} size={18} color={colors.accentText} /></View>
      <View style={styles.sourceCopy}>
        <Text style={styles.sourceGroup} numberOfLines={1}>{item.group_name}</Text>
        <Text style={styles.source} numberOfLines={1}>{item.channel_name}</Text>
      </View>
      <Text maxFontSizeMultiplier={1.3} style={styles.time}>{fmtRelative(item.latest_ts)}</Text>
      <View style={[styles.countPill, item.mentions > 0 && styles.mentionPill]}><Text maxFontSizeMultiplier={1.3} style={[styles.count, item.mentions > 0 && styles.mentionCount]}>{formatUnreadCount(item.unread)}{item.mentions > 0 ? `  @${item.mentions}` : ""}</Text></View>
    </View>
    {item.kind === "thread" ? <Text style={styles.threadTitle} numberOfLines={2}>{previewText(item.title || "") || "Thread"}</Text> : null}
    {item.previews.map(message => <Text key={message.id} style={styles.preview} numberOfLines={1}>
      <Text style={styles.author}>{message.author_name || message.author_id}: </Text>{previewText(message.text) || "Attachment"}
    </Text>)}
  </SwipeRow>;
}

export function inboxTabFromParam(value: string | undefined): InboxTab | null {
  return value === "threads" || value === "unreads" || value === "approvals" || value === "drafts" ? value : null;
}

export function DraftInboxRow({ item, controller }: { item: DraftRow; controller: SwipeRowController }) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const open = () => {
    if (item.thread_id != null) router.push({ pathname: "/(app)/thread/[channelId]/[rootId]", params: {
      channelId: item.channel_id, rootId: String(item.thread_id), groupId: item.group_id, channelName: item.channel_name,
    } });
    else router.push({ pathname: "/(app)/channel/[id]", params: { id: item.channel_id, groupId: item.group_id } });
  };
  return <SwipeRow style={styles.card} onPress={open} controller={controller}
    accessibilityLabel={`Draft in ${item.channel_name}`}
    swipeLeft={{ name: "discard", label: "Discard", icon: Trash2, color: colors.red,
      onPress: () => { void draftSync.discard(draftKey(item.channel_id, item.thread_id), item.rev)
        .then(deleted => {
          if (!deleted && useMessageDrafts.getState().rows.some(row =>
            draftKey(row.channel_id, row.thread_id) === draftKey(item.channel_id, item.thread_id)))
            toast("Draft changed on another device", "warn");
        })
        .catch(e => toastErr("Discard failed", e)); } }}>
    <View style={styles.cardTop}>
      <View style={styles.sourceIcon}><Icon icon={item.thread_id == null ? Hash : MessageSquare} size={18} color={colors.accentText} /></View>
      <View style={styles.sourceCopy}><Text style={styles.sourceGroup} numberOfLines={1}>{item.group_name}</Text>
        <Text style={styles.source} numberOfLines={1}>{item.thread_id != null ? `↳ ${item.thread_title || "Thread"} in ` : ""}{item.channel_name}</Text></View>
      <Text style={styles.time}>{fmtRelative(item.updated_at)}</Text>
    </View>
    <Text style={styles.preview} numberOfLines={2}>{previewText(item.body)}</Text>
  </SwipeRow>;
}

export function ApprovalRow({ item }: { item: ApprovalItem }) {
  const styles = useStyles();
  const open = () => {
    if (item.thread_id != null) {
      router.push({ pathname: "/(app)/thread/[channelId]/[rootId]", params: {
        channelId: item.channel_id, rootId: String(item.thread_id), messageId: String(item.message.id),
        groupId: item.group_id, channelName: item.channel_name,
      } });
    } else {
      router.push({ pathname: "/(app)/channel/[id]", params: {
        id: item.channel_id, groupId: item.group_id, messageId: String(item.message.id),
      } });
    }
  };
  return <View style={styles.card}>
    <Pressable style={styles.approvalContent} onPress={open} accessibilityRole="button"
      accessibilityLabel={`Approval from ${item.message.author_name || item.message.author_id} in ${item.channel_name}`}>
      <Text style={styles.source} numberOfLines={1}>
        {item.kind === "thread" ? `↳ ${previewText(item.title || "Thread")} in ` : ""}#{item.channel_name} · {item.group_name}
      </Text>
      <Text style={styles.time}>{fmtRelative(item.message.ts)}</Text>
      <Text style={styles.preview} numberOfLines={2}>
        <Text style={styles.author}>{item.message.author_name || item.message.author_id}: </Text>
        {previewText(item.message.text) || "Interactive request"}
      </Text>
      {item.pending_count > 1 && <Text style={styles.moreCount}>+{item.pending_count - 1} more</Text>}
    </Pressable>
    {!!item.message.meta?.options?.length && <MessageOptions message={item.message} />}
  </View>;
}

export default function InboxScreen({ initialSwipe }: {
  initialSwipe?: "left";
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { tab: routeTab } = useLocalSearchParams<{ tab?: string }>();
  const rememberedTab = useInboxTab(state => state.tab);
  const setRememberedTab = useInboxTab(state => state.setTab);
  const filter = useInboxTab(state => state.filter);
  const setFilter = useInboxTab(state => state.setFilter);
  const unreads = useUnreads();
  const approvals = useApprovals();
  const drafts = useSyncedDrafts();
  const draftsLoading = useMessageDrafts(s => s.loading);
  const draftsError = useMessageDrafts(s => s.loadError);
  const draftsEnabled = useMe().data?.drafts_sync === true;
  const markRead = useMarkUnreadsRead();
  const swipeRows = useSwipeRows();
  const tab = rememberedTab === "drafts" && !draftsEnabled ? "unreads" : rememberedTab;
  React.useEffect(() => { if (tab === "drafts") void draftSync.hydrate().catch(() => {}); }, [tab]);
  React.useEffect(() => {
    const next = inboxTabFromParam(routeTab);
    if (next) setRememberedTab(next);
  }, [routeTab]);
  const displayedItems = filterUnreads(unreads.data ?? [], filter);
  const limited = unreads.total > (unreads.data?.length ?? 0);
  const unreadTotal = unreads.data?.reduce((sum, item) => sum + item.unread, 0) ?? 0;
  const showTabCount = !limited && !unreads.data?.some(item => item.unread >= 100);
  const markLabel = limited ? "Mark shown read" : filter === "all" ? "Mark all read" : "Mark these read";
  const mark = (items: UnreadItem[]) => markRead.mutate(items, { onError: e => toastErr("Mark read failed", e) });
  return <View style={styles.root}>
    <Stack.Screen options={{ title: "Inbox", headerShown: true }} />
    <View style={styles.tabs} accessibilityRole="tablist">
      {(["unreads", "threads", "approvals", ...(draftsEnabled ? ["drafts"] as const : [])] as const).map(option => <Pressable key={option}
        accessibilityRole="tab" accessibilityState={{ selected: tab === option }}
        accessibilityLabel={option === "threads" ? "Threads" : option === "drafts" ? `Drafts${drafts.length ? `, ${drafts.length}` : ""}` : option === "approvals" ? `Approvals${approvals.total ? `, ${approvals.total} pending` : ""}` : `Unreads${showTabCount && unreadTotal ? `, ${unreadTotal} unread messages` : ""}`}
        style={[styles.tab, tab === option && styles.tabActive]}
        onPress={() => { swipeRows.close(); setRememberedTab(option); }}>
        <Text style={[styles.tabText, tab === option && styles.tabTextActive]} numberOfLines={1} maxFontSizeMultiplier={1.1}>
          {option === "unreads" ? `Unreads${showTabCount && unreadTotal ? ` (${unreadTotal})` : ""}` : option === "approvals" ? `Approvals${approvals.total ? ` (${approvals.total})` : ""}` : option === "drafts" ? `Drafts${drafts.length ? ` (${drafts.length})` : ""}` : "Threads"}
        </Text>
      </Pressable>)}
    </View>
    {tab === "drafts" && draftsEnabled ? <FlatList style={styles.list} contentContainerStyle={styles.listContent}
      data={drafts} keyExtractor={item => draftKey(item.channel_id, item.thread_id)}
      renderItem={({ item }) => <DraftInboxRow item={item} controller={swipeRows} />}
      ListEmptyComponent={draftsLoading ? <ActivityIndicator color={colors.dim} style={styles.empty} /> : draftsError ?
        <View style={styles.empty}><Text style={styles.error}>Couldn't load drafts</Text>
          <Pressable accessibilityRole="button" onPress={() => void draftSync.hydrate().catch(() => {})}><Text style={styles.markAll}>Retry</Text></Pressable>
        </View> : <EmptyState icon={MessageSquare} title="No drafts" description="Messages you start writing will appear here." />}
    /> : tab === "threads" ? <ThreadsScreen embedded /> : tab === "approvals" ?
      <FlatList style={styles.list} contentContainerStyle={styles.listContent}
        data={approvals.data ?? []}
        keyExtractor={item => `${item.channel_id}:${item.thread_id ?? "channel"}`}
        renderItem={({ item }) => <ApprovalRow item={item} />}
        refreshControl={<RefreshControl refreshing={approvals.isRefetching} onRefresh={() => void approvals.refetch()} tintColor={colors.dim} />}
        ListEmptyComponent={approvals.isLoading ? <ActivityIndicator color={colors.dim} style={styles.empty} /> :
          approvals.isError ? <View style={styles.empty}><Text style={styles.error}>Couldn't load approvals</Text>
            <Pressable accessibilityRole="button" onPress={() => void approvals.refetch()}><Text style={styles.markAll}>Retry</Text></Pressable>
          </View> : <EmptyState icon={Check} title="No pending approvals" description="Requests awaiting your response will appear here." />}
      /> : <>
      <View style={styles.toolbar}>
        <View style={styles.filterRow}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterScroll} contentContainerStyle={styles.filters}>
          {(["all", "mentions", "channels", "threads"] as const).map(option =>
          <Pressable accessibilityRole="button" accessibilityLabel={`Filter unreads: ${option === "mentions" ? "mentions" : option}`} accessibilityState={{ selected: filter === option }} key={option} style={[styles.filter, filter === option && styles.filterActive]}
            onPress={() => { swipeRows.close(); setFilter(option); }}><Text style={[styles.filterText, filter === option && styles.filterTextActive]}>
              {option === "mentions" ? "@Mentions" : option[0].toUpperCase() + option.slice(1)}
            </Text></Pressable>)}</ScrollView>
        {!!displayedItems.length && <Pressable accessibilityRole="button" accessibilityLabel={markLabel}
          accessibilityHint="Marks the currently displayed conversations as read"
          accessibilityState={{ disabled: markRead.isPending, busy: markRead.isPending }}
          style={[styles.markButton, markRead.isPending && styles.disabled]}
          onPress={() => { swipeRows.close(); mark(displayedItems); }} disabled={markRead.isPending}>
          {markRead.isPending ? <ActivityIndicator size="small" color={colors.a1} /> : <Icon icon={CheckCheck} size={20} color={colors.a1} />}
        </Pressable>}
        </View>
        {limited && <Text style={styles.limit}>Showing {unreads.data?.length ?? 0} of {unreads.total}</Text>}
      </View>
      <FlatList style={styles.list} contentContainerStyle={styles.listContent}
        onScrollBeginDrag={swipeRows.close}
        data={displayedItems}
        keyExtractor={item => `${item.kind}:${item.thread_id ?? item.channel_id}`}
        renderItem={({ item, index }) => <UnreadRow item={item} onRead={read => mark([read])}
          controller={swipeRows} initialSwipe={index === 0 ? initialSwipe : undefined} />}
        refreshControl={<RefreshControl refreshing={unreads.isRefetching} onRefresh={() => void unreads.refetch()} tintColor={colors.dim} />}
        ListEmptyComponent={unreads.isLoading ? <ActivityIndicator color={colors.dim} style={styles.empty} /> :
          unreads.isError ? <View style={styles.empty}><Text style={styles.error}>Couldn't load unreads</Text>
            <Pressable accessibilityRole="button" onPress={() => void unreads.refetch()}>
              <Text style={styles.markAll}>Retry</Text>
            </Pressable></View> :
          <EmptyState icon={CheckCheck} title="You're all caught up" description="New messages will appear here." />}
      />
    </>}
  </View>;
}

const useStyles = createThemedStyles(({ colors, surfaces }) => ({
  root: { flex: 1, backgroundColor: colors.bg },
  tabs: { flexDirection: "row", marginHorizontal: layout.gutter, marginTop: space.sm, marginBottom: space.sm, padding: space.xs, borderRadius: radii.lg, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border },
  tab: { flex: 1, minWidth: 0, minHeight: 44, justifyContent: "center", alignItems: "center", paddingHorizontal: space.xs, paddingVertical: space.sm, borderRadius: radii.md },
  tabActive: { backgroundColor: colors.accentSoft },
  tabText: { ...typography.bodySm, textAlign: "center", color: colors.dim, fontWeight: weight.semibold },
  tabTextActive: { color: colors.accentText },
  toolbar: { paddingHorizontal: layout.gutter, paddingTop: space.sm, gap: space.xs },
  filterRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  filterScroll: { flex: 1 },
  filters: { alignItems: "center", gap: 6 },
  filter: { minWidth: 48, minHeight: 44, justifyContent: "center", borderRadius: radii.pill, paddingHorizontal: space.md, paddingVertical: space.xs },
  filterActive: { backgroundColor: colors.panelStrong },
  filterText: { textAlign: "center", color: colors.faint, ...typography.caption },
  filterTextActive: { color: colors.text },
  markAll: { color: colors.a1, fontWeight: weight.bold },
  limit: { color: colors.dim, fontSize: typography.caption.fontSize },
  error: { color: colors.text, marginBottom: 8 },
  list: { flex: 1 },
  listContent: { paddingHorizontal: layout.gutter, paddingTop: space.sm, gap: space.md, paddingBottom: layout.contentBottom },
  card: { ...surfaces.card, padding: space.lg, gap: space.xs },
  approvalContent: { gap: space.xs },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  sourceIcon: { width: 36, height: 36, borderRadius: radii.md, alignItems: "center", justifyContent: "center", backgroundColor: colors.accentSoft },
  sourceCopy: { flex: 1, gap: 2, marginBottom: space.sm },
  sourceGroup: { ...typography.caption, color: colors.faint },
  source: { ...typography.message, color: colors.text, fontWeight: weight.semibold },
  threadTitle: { fontSize: typography.body.fontSize, color: colors.text, fontWeight: weight.semibold },
  markButton: { width: 44, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radii.md, backgroundColor: colors.accentWash },
  disabled: { opacity: 0.5 },
  countPill: { minWidth: 24, paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radii.pill, backgroundColor: colors.accentSoft },
  mentionPill: { backgroundColor: colors.mentionSurface },
  count: { ...typography.caption, color: colors.accentText, fontWeight: weight.bold, textAlign: "center" },
  moreCount: { ...typography.caption, color: colors.accentText, fontWeight: weight.bold },
  mentionCount: { color: colors.red },
  time: { color: colors.faint, fontSize: typography.caption.fontSize },
  preview: { fontSize: typography.bodySm.fontSize, fontWeight: typography.bodySm.fontWeight, color: colors.dim },
  author: { color: colors.text, fontWeight: weight.medium },
  empty: { color: colors.dim, textAlign: "center", paddingVertical: 60 },
}));
