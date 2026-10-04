import { previewText } from "../../src/lib/previewText";
import { ResponsiveText as Text } from "../../src/components/ResponsiveText";
import React from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { Check, CheckCheck, Hash, MessageSquare } from "lucide-react-native";
import { filterUnreads, fmtRelative, formatUnreadCount, useMarkUnreadsRead, useUnreads, type UnreadFilter, type UnreadItem } from "@agora/core";
import { EmptyState } from "../../src/components/EmptyState";
import { colors, typography, space, radii, weight, type Palette } from "../../src/lib/theme";
import { createThemedStyles, useAppTheme } from "../../src/lib/useTheme";
import { toastErr } from "../../src/components/Toast";
import { SwipeRow, useSwipeRows, type SwipeAction, type SwipeRowController } from "../../src/components/SwipeRow";
import { ThreadsScreen } from "./threads";
import { Icon } from "../../src/components/Icon";
import { layout } from "../../src/lib/theme";

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

export function inboxTabFromParam(value: string | undefined): "unreads" | "threads" | null {
  return value === "threads" || value === "unreads" ? value : null;
}

export default function InboxScreen({ initialTab = null, initialSwipe }: {
  initialTab?: "unreads" | "threads" | null; initialSwipe?: "left";
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { tab: routeTab } = useLocalSearchParams<{ tab?: string }>();
  const unreads = useUnreads();
  const markRead = useMarkUnreadsRead();
  const swipeRows = useSwipeRows();
  const [tab, setTab] = React.useState<"unreads" | "threads" | null>(
    initialTab ?? inboxTabFromParam(routeTab));
  const [filter, setFilter] = React.useState<UnreadFilter>("all");
  React.useEffect(() => {
    const next = inboxTabFromParam(routeTab);
    if (next) setTab(next);
  }, [routeTab]);
  React.useEffect(() => {
    if (tab === null && !unreads.isLoading) {
      setTab(!unreads.isError && (unreads.data?.length ?? 0) > 0 ? "unreads" : "threads");
    }
  }, [tab, unreads.isLoading, unreads.isError, unreads.data]);
  const activeTab = tab ?? (unreads.isLoading || (!unreads.isError && (unreads.data?.length ?? 0) > 0) ? "unreads" : "threads");
  const displayedItems = filterUnreads(unreads.data ?? [], filter);
  const limited = unreads.total > (unreads.data?.length ?? 0);
  const unreadTotal = unreads.data?.reduce((sum, item) => sum + item.unread, 0) ?? 0;
  const showTabCount = !limited && !unreads.data?.some(item => item.unread >= 100);
  const markLabel = limited ? "Mark shown read" : filter === "all" ? "Mark all read" : "Mark these read";
  const mark = (items: UnreadItem[]) => markRead.mutate(items, { onError: e => toastErr("Mark read failed", e) });
  return <View style={styles.root}>
    <Stack.Screen options={{ title: "Inbox", headerShown: true }} />
    <View style={styles.tabs} accessibilityRole="tablist">
      {(["unreads", "threads"] as const).map(option => <Pressable key={option}
        accessibilityRole="tab" accessibilityState={{ selected: activeTab === option }}
        accessibilityLabel={option === "threads" ? "Threads" : `Unreads${showTabCount && unreadTotal ? `, ${unreadTotal} unread messages` : ""}`}
        style={[styles.tab, activeTab === option && styles.tabActive]}
        onPress={() => { swipeRows.close(); setTab(option); }}>
        <Text style={[styles.tabText, activeTab === option && styles.tabTextActive]}>
          {option === "unreads" ? `Unreads${showTabCount && unreadTotal ? ` (${unreadTotal})` : ""}` : "Threads"}
        </Text>
      </Pressable>)}
    </View>
    {activeTab === "threads" ? <ThreadsScreen embedded /> : <>
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
  tab: { flex: 1, minWidth: 0, minHeight: 44, justifyContent: "center", alignItems: "center", paddingHorizontal: space.sm, paddingVertical: space.sm, borderRadius: radii.md },
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
  mentionCount: { color: colors.red },
  time: { color: colors.faint, fontSize: typography.caption.fontSize },
  preview: { fontSize: typography.bodySm.fontSize, fontWeight: typography.bodySm.fontWeight, color: colors.dim },
  author: { color: colors.text, fontWeight: weight.medium },
  empty: { color: colors.dim, textAlign: "center", paddingVertical: 60 },
}));
