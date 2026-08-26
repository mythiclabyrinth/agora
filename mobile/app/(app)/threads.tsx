/* Threads inbox: every thread you started or replied in, newest activity
   first, with per-thread unread badges — the mobile take on Slack's
   "Threads" view. Tapping a row opens the thread screen directly;
   long-pressing renames it or removes the row from your inbox. */

import React from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, router } from "expo-router";
import { Check, ListFilter, MessagesSquare, X } from "lucide-react-native";
import {
  filterAndSortThreads,
  useHideThread,
  useRenameThread,
  useThreads,
} from "@agora/core";
import type { ThreadFilter, ThreadRow, ThreadSort } from "@agora/core";
import { Icon } from "../../src/components/Icon";
import { toastErr } from "../../src/components/Toast";
import { fmtTs } from "@agora/core";
import { headerActions } from "../../src/lib/headerItems";
import { colors } from "../../src/lib/theme";
import { usePrefs } from "../../src/state/prefs";

const SORT_OPTIONS: { value: ThreadSort; label: string }[] = [
  { value: "recent", label: "Recent" },
  { value: "oldest", label: "Oldest" },
  { value: "az", label: "A–Z" },
  { value: "za", label: "Z–A" },
];

const FILTER_OPTIONS: { value: ThreadFilter; label: string }[] = [
  { value: "all", label: "All Threads" },
  { value: "saved", label: "Saved Threads" },
  { value: "unset", label: "Unset Threads" },
];

function snippet(t: ThreadRow): string {
  const alias = (t.root.alias ?? "").trim();
  if (alias) return alias;
  const text = t.root.text.replace(/\s+/g, " ").trim();
  return text || "(attachment)";
}

function Row({
  thread,
  onRename,
}: {
  thread: ThreadRow;
  onRename: (t: ThreadRow) => void;
}) {
  const hideThread = useHideThread();
  const onLongPress = () => {
    // Removing a thread from the inbox is per-user server-side (the
    // messages stay in the channel), so anyone may do it.
    const remove = () =>
      hideThread.mutate(thread.root.id, {
        onError: (e) => toastErr("Remove failed", e),
      });
    Alert.alert("Thread", snippet(thread), [
      { text: "Rename…", onPress: () => onRename(thread) },
      { text: "Remove", style: "destructive" as const, onPress: remove },
      { text: "Cancel", style: "cancel" },
    ]);
  };
  return (
    <Pressable
      style={[styles.row, thread.unread > 0 ? styles.rowUnread : null]}
      onPress={() =>
        router.push({
          pathname: "/(app)/thread/[channelId]/[rootId]",
          params: {
            channelId: thread.channel_id,
            rootId: String(thread.root.id),
            channelName: thread.channel_name,
          },
        })
      }
      onLongPress={onLongPress}
      delayLongPress={350}
    >
      <View style={styles.top}>
        <Text style={styles.chan} numberOfLines={1}>
          <Text style={styles.hash}># </Text>
          {thread.channel_name}
          <Text style={styles.grp}> · {thread.group_name}</Text>
        </Text>
        <Text style={styles.ts}>{fmtTs(thread.last_reply_ts)}</Text>
      </View>
      <View style={styles.mid}>
        <Text style={styles.author} numberOfLines={1}>
          {thread.root.author_name || thread.root.author_id}
        </Text>
        <Text style={styles.snippet} numberOfLines={1}>
          {snippet(thread)}
        </Text>
      </View>
      <View style={styles.foot}>
        <Text style={styles.replies}>
          {thread.reply_count} {thread.reply_count === 1 ? "reply" : "replies"}
        </Text>
        {thread.unread > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>
              {thread.unread > 99 ? "99+" : thread.unread}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

/* Rename dialog: prefilled with the current alias; empty Save clears it back
   to the first message. Anyone who can see the thread may rename it. */
export function RenameModal({
  thread,
  onClose,
}: {
  thread: ThreadRow | null;
  onClose: () => void;
}) {
  const rename = useRenameThread();
  const [text, setText] = React.useState("");
  React.useEffect(() => {
    setText(thread?.root.alias ?? "");
  }, [thread]);
  if (!thread) return null;
  const save = () => {
    rename.mutate(
      { threadId: thread.root.id, alias: text.trim() },
      { onError: (e) => toastErr("Rename failed", e) },
    );
    onClose();
  };
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Pressable
          style={styles.dialog}
          onPress={() => {}}
          accessibilityViewIsModal
          accessibilityLabel="Rename thread dialog"
          testID="rename-thread-dialog"
        >
          <Text style={styles.dialogTitle}>Rename thread</Text>
          <Text style={styles.dialogHint}>
            Leave blank to show the first message.
          </Text>
          <TextInput
            style={styles.dialogInput}
            value={text}
            onChangeText={setText}
            placeholder="Thread name"
            placeholderTextColor={colors.faint}
            autoFocus
            maxLength={140}
            returnKeyType="done"
            onSubmitEditing={save}
          />
          <View style={styles.dialogBtns}>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={styles.dialogCancel}>Cancel</Text>
            </Pressable>
            <Pressable onPress={save} hitSlop={8}>
              <Text style={styles.dialogOk}>Save</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export function ThreadViewSheet({
  sort,
  filter,
  onSort,
  onFilter,
  onClose,
}: {
  sort: ThreadSort;
  filter: ThreadFilter;
  onSort: (sort: ThreadSort) => void;
  onFilter: (filter: ThreadFilter) => void;
  onClose: () => void;
}) {
  const choices = <T extends string>(
    options: { value: T; label: string }[],
    selected: T,
    onSelect: (value: T) => void,
  ) => options.map((option) => {
    const checked = option.value === selected;
    return (
      <Pressable
        key={option.value}
        style={[styles.choice, checked ? styles.choiceSelected : null]}
        accessibilityRole="radio"
        accessibilityState={{ checked }}
        onPress={() => onSelect(option.value)}
      >
        <Text style={[styles.choiceText, checked ? styles.choiceTextSelected : null]}>
          {option.label}
        </Text>
        {checked ? <Icon icon={Check} size={18} color={colors.a1} /> : null}
      </Pressable>
    );
  });

  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdropBottom} onPress={onClose}>
        <Pressable
          style={styles.viewSheet}
          onPress={() => {}}
          accessibilityViewIsModal
          accessibilityLabel="Thread view options"
          testID="thread-view-sheet"
        >
          <View style={styles.sheetHead}>
            <View style={styles.sheetTitleBlock}>
              <Text style={styles.sheetTitle}>Thread view</Text>
              <Text style={styles.sheetHint}>Changes apply immediately.</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close thread view options"
              onPress={onClose} hitSlop={10}>
              <Icon icon={X} size={20} color={colors.dim} />
            </Pressable>
          </View>
          <Text style={styles.sectionLabel}>Sort by</Text>
          <View accessibilityRole="radiogroup" style={styles.choiceGroup}>
            {choices(SORT_OPTIONS, sort, onSort)}
          </View>
          <Text style={styles.sectionLabel}>Show</Text>
          <View accessibilityRole="radiogroup" style={styles.choiceGroup}>
            {choices(FILTER_OPTIONS, filter, onFilter)}
          </View>
          <Pressable accessibilityRole="button" style={styles.doneButton} onPress={onClose}>
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export default function ThreadsScreen() {
  const threads = useThreads();
  const [renaming, setRenaming] = React.useState<ThreadRow | null>(null);
  const [viewOptionsOpen, setViewOptionsOpen] = React.useState(false);
  const sort = usePrefs((state) => state.threadSort);
  const filter = usePrefs((state) => state.threadFilter);
  const setSort = usePrefs((state) => state.setThreadSort);
  const setFilter = usePrefs((state) => state.setThreadFilter);
  const displayedThreads = React.useMemo(
    () => filterAndSortThreads(threads.data ?? [], sort, filter),
    [threads.data, sort, filter],
  );
  const optionsActive = sort !== "recent" || filter !== "all";
  return (
    <>
      <Stack.Screen options={{
        title: "Threads",
        headerShown: true,
        ...headerActions(
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Thread view options${optionsActive ? ", filters active" : ""}`}
            hitSlop={10}
            style={[styles.headerButton, optionsActive ? styles.headerButtonActive : null]}
            onPress={() => setViewOptionsOpen(true)}
          >
            <Icon icon={ListFilter} size={21} color={optionsActive ? colors.a1 : colors.text} />
          </Pressable>,
        ),
      }} />
      <RenameModal thread={renaming} onClose={() => setRenaming(null)} />
      {viewOptionsOpen ? (
        <ThreadViewSheet sort={sort} filter={filter} onSort={setSort} onFilter={setFilter}
          onClose={() => setViewOptionsOpen(false)} />
      ) : null}
      <FlatList
        style={styles.root}
        contentContainerStyle={styles.content}
        data={displayedThreads}
        keyExtractor={(t) => String(t.root.id)}
        renderItem={({ item }) => (
          <Row thread={item} onRename={setRenaming} />
        )}
        refreshControl={
          <RefreshControl
            refreshing={threads.isRefetching}
            onRefresh={() => void threads.refetch()}
            tintColor={colors.dim}
          />
        }
        ListEmptyComponent={
          threads.isLoading ? (
            <ActivityIndicator color={colors.dim} style={{ paddingVertical: 40 }} />
          ) : (threads.data?.length ?? 0) > 0 ? (
            <View style={styles.empty}>
              <Icon icon={MessagesSquare} size={34} color={colors.faint} />
              <Text style={styles.emptyText}>No matching threads</Text>
              <Text style={styles.emptyHint}>Try showing a different set of threads.</Text>
            </View>
          ) : (
            <View style={styles.empty}>
              <Icon icon={MessagesSquare} size={34} color={colors.faint} />
              <Text style={styles.emptyText}>No threads yet</Text>
              <Text style={styles.emptyHint}>
                Threads you start or reply in show up here, with unread counts
                as replies land.
              </Text>
            </View>
          )
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  headerButton: { padding: 6, borderRadius: 9 },
  headerButtonActive: { backgroundColor: "rgba(139,124,255,0.14)" },
  content: { padding: 14, gap: 10, paddingBottom: 40 },
  row: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 11,
    gap: 4,
  },
  rowUnread: { borderColor: "rgba(139,124,255,0.45)" },
  top: { flexDirection: "row", alignItems: "baseline", gap: 10 },
  chan: { color: colors.text, fontSize: 12.5, fontWeight: "700", flex: 1 },
  hash: { color: colors.faint },
  grp: { color: colors.faint, fontWeight: "400" },
  ts: { color: colors.faint, fontSize: 11 },
  mid: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  author: { color: colors.a1, fontSize: 13, fontWeight: "700", flexShrink: 0 },
  snippet: { color: colors.dim, fontSize: 13.5, flex: 1 },
  foot: { flexDirection: "row", alignItems: "center", gap: 10 },
  replies: { color: colors.faint, fontSize: 11.5 },
  badge: {
    backgroundColor: "rgba(139,124,255,0.35)",
    borderRadius: 9,
    minWidth: 20,
    paddingHorizontal: 5,
    paddingVertical: 1,
    alignItems: "center",
  },
  badgeText: { color: colors.text, fontSize: 11.5, fontWeight: "800" },
  empty: { alignItems: "center", paddingVertical: 60, gap: 6 },
  emptyText: { color: colors.dim, fontSize: 15, fontWeight: "600" },
  emptyHint: {
    color: colors.faint,
    fontSize: 12.5,
    textAlign: "center",
    paddingHorizontal: 40,
    lineHeight: 18,
  },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    padding: 28,
  },
  dialog: {
    backgroundColor: colors.sheet,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: 18,
    gap: 10,
  },
  dialogTitle: { color: colors.text, fontSize: 16, fontWeight: "800" },
  dialogHint: { color: colors.faint, fontSize: 12.5 },
  dialogInput: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 15,
  },
  dialogBtns: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 22,
    marginTop: 4,
  },
  dialogCancel: { color: colors.dim, fontSize: 15, fontWeight: "600" },
  dialogOk: { color: colors.a1, fontSize: 15, fontWeight: "800" },
  sheetBackdropBottom: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  viewSheet: {
    backgroundColor: colors.sheet,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 18,
    paddingBottom: 34,
    gap: 12,
  },
  sheetHead: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  sheetTitleBlock: { flex: 1, gap: 3 },
  sheetTitle: { color: colors.text, fontSize: 18, fontWeight: "800" },
  sheetHint: { color: colors.faint, fontSize: 12.5 },
  sectionLabel: {
    color: colors.faint,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginTop: 2,
  },
  choiceGroup: { gap: 6 },
  choice: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 11,
    backgroundColor: colors.panel,
  },
  choiceSelected: {
    borderColor: "rgba(139,124,255,0.5)",
    backgroundColor: "rgba(139,124,255,0.10)",
  },
  choiceText: { color: colors.dim, fontSize: 14, fontWeight: "600" },
  choiceTextSelected: { color: colors.text },
  doneButton: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 11,
    backgroundColor: colors.a1,
    marginTop: 2,
  },
  doneText: { color: "#fff", fontSize: 14, fontWeight: "800" },
});
