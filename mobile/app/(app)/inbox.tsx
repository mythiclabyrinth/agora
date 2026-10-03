import { previewText } from "../../src/lib/previewText";
import { ResponsiveText as Text } from "../../src/components/ResponsiveText";
import React from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { Check, CheckCheck } from "lucide-react-native";
import { filterUnreads, fmtRelative, formatUnreadCount, useMarkUnreadsRead, useUnreads, type UnreadFilter, type UnreadItem } from "@agora/core";
import { EmptyState } from "../../src/components/EmptyState";
import { colors, typography, space, radii, weight } from "../../src/lib/theme";
import { toastErr } from "../../src/components/Toast";
import { SwipeRow, useSwipeRows, type SwipeAction, type SwipeRowController } from "../../src/components/SwipeRow";
import { ThreadsScreen } from "./threads";

export function unreadSwipeAction(item: UnreadItem, onRead: (item: UnreadItem) => void): SwipeAction {
  return { name: "markRead", label: "Mark read", icon: Check, color: colors.a1,
    onPress: () => onRead(item) };
}

export function UnreadRow({ item, onRead, controller, initialSwipe }: {
  item: UnreadItem; onRead: (item: UnreadItem) => void;
  controller: SwipeRowController; initialSwipe?: "left";
}) {
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
    swipeLeft={unreadSwipeAction(item, onRead)}
    onLongPress={() => Alert.alert("Mark read", `Mark ${item.kind} read?`, [
      { text: "Open", onPress: open },
      { text: "Mark read", onPress: () => onRead(item) },
      { text: "Cancel", style: "cancel" },
    ])}>
    <View style={styles.cardTop}>
      <Text style={styles.source} numberOfLines={2}>
        {item.group_id === "__dms" ? "" : "#"}{item.channel_name} · {item.group_name}
      </Text>
      <Text maxFontSizeMultiplier={1.3} style={styles.time}>{fmtRelative(item.latest_ts)}</Text>
      <Text maxFontSizeMultiplier={1.3} style={styles.count}>{formatUnreadCount(item.unread)}{item.mentions > 0 ? `  @${item.mentions}` : ""}</Text>
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
  const mark = (items: UnreadItem[]) => markRead.mutate(items, { onError: e => toastErr("Mark read failed", e) });
  return <View style={styles.root}>
    <Stack.Screen options={{ title: "Inbox", headerShown: true }} />
    <View style={styles.tabs}>
      {(["unreads", "threads"] as const).map(option => <Pressable key={option}
        accessibilityRole="tab" accessibilityState={{ selected: activeTab === option }}
        style={[styles.tab, activeTab === option && styles.tabActive]}
        onPress={() => { swipeRows.close(); setTab(option); }}>
        <Text style={[styles.tabText, activeTab === option && styles.tabTextActive]}>
          {option === "unreads" ? `Unreads${showTabCount && unreadTotal ? ` (${unreadTotal})` : ""}` : "Threads"}
        </Text>
      </Pressable>)}
    </View>
    {activeTab === "threads" ? <ThreadsScreen embedded /> : <>
      <View style={styles.toolbar}>
        <View style={styles.filters}>{(["all", "mentions", "channels", "threads"] as const).map(option =>
          <Pressable hitSlop={6} accessibilityRole="button" accessibilityState={{ selected: filter === option }} key={option} style={[styles.filter, filter === option && styles.filterActive]}
            onPress={() => { swipeRows.close(); setFilter(option); }}><Text style={styles.filterText}>
              {option === "mentions" ? "@Mentions" : option[0].toUpperCase() + option.slice(1)}
            </Text></Pressable>)}</View>
        {limited && <Text style={styles.limit}>Showing {unreads.data?.length ?? 0} of {unreads.total}</Text>}
        {!!displayedItems.length && <Pressable accessibilityRole="button" style={styles.markButton} onPress={() => { swipeRows.close(); mark(displayedItems); }} disabled={markRead.isPending}>
          <Text style={styles.markAll}>{limited ? "Mark shown read" : filter === "all" ? "Mark all read" : "Mark these read"}</Text>
        </Pressable>}
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

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  tabs: { flexDirection: "row", marginHorizontal: space.lg, marginVertical: space.sm, padding: space.xs, borderRadius: radii.lg, backgroundColor: colors.panel },
  tab: { flex: 1, minHeight: 44, justifyContent: "center", alignItems: "center", paddingVertical: space.sm, borderRadius: radii.md },
  tabActive: { backgroundColor: colors.panelStrong },
  tabText: { color: colors.dim, fontWeight: weight.semibold },
  tabTextActive: { color: colors.text },
  toolbar: { paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.xs },
  filters: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  filter: { minWidth: 48, minHeight: 32, justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radii.pill, paddingHorizontal: space.md, paddingVertical: space.xs },
  filterActive: { borderColor: colors.a1, backgroundColor: colors.accentSoft },
  filterText: { textAlign: "center", color: colors.text, fontSize: typography.caption.fontSize },
  markAll: { color: colors.a1, fontWeight: weight.bold, alignSelf: "flex-end" },
  limit: { color: colors.dim, fontSize: typography.caption.fontSize },
  error: { color: colors.text, marginBottom: 8 },
  list: { flex: 1 },
  listContent: { padding: space.md, gap: space.sm, paddingBottom: 40 },
  card: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 10, gap: 2 },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  source: { fontSize: typography.meta.fontSize, flex: 1, color: colors.dim, fontWeight: weight.semibold },
  threadTitle: { fontSize: typography.body.fontSize, color: colors.text, fontWeight: weight.semibold },
  markButton: { minHeight: 44, justifyContent: "center", alignSelf: "flex-end" },
  count: { color: colors.a1, fontWeight: weight.bold },
  time: { color: colors.faint, fontSize: typography.caption.fontSize },
  preview: { fontSize: typography.bodySm.fontSize, fontWeight: typography.bodySm.fontWeight, color: colors.dim },
  author: { color: colors.text, fontWeight: weight.medium },
  empty: { color: colors.dim, textAlign: "center", paddingVertical: 60 },
});
