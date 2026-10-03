import React from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { Check } from "lucide-react-native";
import { filterUnreads, fmtRelative, formatUnreadCount, useMarkUnreadsRead, useUnreads, type UnreadFilter, type UnreadItem } from "@agora/core";
import { colors } from "../../src/lib/theme";
import { toastErr } from "../../src/components/Toast";
import { SwipeRow, useSwipeRows, type SwipeAction, type SwipeRowController } from "../../src/components/SwipeRow";
import { ThreadsScreen } from "./threads";

export function unreadSwipeAction(item: UnreadItem, onRead: (item: UnreadItem) => void): SwipeAction {
  return { name: "markRead", label: "Mark read", icon: Check, color: colors.a1,
    onPress: () => onRead(item) };
}

function UnreadRow({ item, onRead, controller, initialSwipe }: {
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
      <Text style={styles.source} numberOfLines={1}>
        {item.kind === "thread" ? `↳ ${item.title || "Thread"} in ` : ""}#{item.channel_name} · {item.group_name}
      </Text>
      <Text style={styles.time}>{fmtRelative(item.latest_ts)}</Text>
      <Text style={styles.count}>{formatUnreadCount(item.unread)}{item.mentions > 0 ? `  @${item.mentions}` : ""}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Mark ${item.kind} read`}
        style={styles.markOne} onPress={event => { event.stopPropagation(); controller.close(); onRead(item); }}>
        <Text style={styles.markOneText}>✓</Text>
      </Pressable>
    </View>
    {item.previews.map(message => <Text key={message.id} style={styles.preview} numberOfLines={1}>
      <Text style={styles.author}>{message.author_name || message.author_id}: </Text>{message.text || "Attachment"}
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
          <Pressable key={option} style={[styles.filter, filter === option && styles.filterActive]}
            onPress={() => { swipeRows.close(); setFilter(option); }}><Text style={styles.filterText}>
              {option === "mentions" ? "@Mentions" : option[0].toUpperCase() + option.slice(1)}
            </Text></Pressable>)}</View>
        {limited && <Text style={styles.limit}>Showing {unreads.data?.length ?? 0} of {unreads.total}</Text>}
        {!!displayedItems.length && <Pressable onPress={() => { swipeRows.close(); mark(displayedItems); }} disabled={markRead.isPending}>
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
          <Text style={styles.empty}>You're all caught up</Text>}
      />
    </>}
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  tabs: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: colors.border },
  tab: { flex: 1, alignItems: "center", paddingVertical: 12 },
  tabActive: { borderBottomWidth: 2, borderBottomColor: colors.a1 },
  tabText: { color: colors.dim, fontWeight: "600" },
  tabTextActive: { color: colors.text },
  toolbar: { padding: 12, gap: 10 },
  filters: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  filter: { borderWidth: 1, borderColor: colors.border, borderRadius: 14, paddingHorizontal: 9, paddingVertical: 5 },
  filterActive: { borderColor: colors.a1, backgroundColor: "rgba(139,124,255,0.14)" },
  filterText: { color: colors.text, fontSize: 12 },
  markAll: { color: colors.a1, fontWeight: "700", alignSelf: "flex-end" },
  limit: { color: colors.dim, fontSize: 12 },
  error: { color: colors.text, marginBottom: 8 },
  list: { flex: 1 },
  listContent: { padding: 12, gap: 8, paddingBottom: 40 },
  card: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: 13, padding: 13, gap: 5 },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  source: { flex: 1, color: colors.text, fontWeight: "700" },
  count: { color: colors.a1, fontWeight: "800" },
  time: { color: colors.faint, fontSize: 11 },
  markOne: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  markOneText: { color: colors.a1, fontSize: 20 },
  preview: { color: colors.dim, fontSize: 13 },
  author: { color: colors.text, fontWeight: "600" },
  empty: { color: colors.dim, textAlign: "center", paddingVertical: 60 },
});
