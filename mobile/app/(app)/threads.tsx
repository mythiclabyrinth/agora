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
import { Redirect, Stack, router } from "expo-router";
import { ListFilter, MessagesSquare, Pencil, Trash2, X } from "lucide-react-native";
import {
  filterAndSortThreads,
  threadActivityTs,
  resolveThreadGroupSelection,
  useGroups,
  useHideThread,
  useUnhideThread,
  useRenameThread,
  useThreads,
} from "@agora/core";
import type { ThreadFilter, ThreadRow, ThreadSort } from "@agora/core";
import { Icon } from "../../src/components/Icon";
import { SelectDropdown, SelectDropdownMenu } from "../../src/components/SelectDropdown";
import { SwipeRow, useSwipeRows, type SwipeAction, type SwipeRowController } from "../../src/components/SwipeRow";
import { toastAction, toastErr } from "../../src/components/Toast";
import { ThreadInboxFooter, ThreadRelativeTime } from "../../src/components/ThreadTimeMeta";
import { headerActions } from "../../src/lib/headerItems";
import { colors, typography, weight } from "../../src/lib/theme";
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

export function threadSwipeActions(thread: ThreadRow, onRename: (thread: ThreadRow) => void,
  onRemove: () => void): { swipeLeft: SwipeAction; swipeRight: SwipeAction } {
  return {
    swipeLeft: { name: "remove", label: "Remove", icon: Trash2, color: colors.red, onPress: onRemove },
    swipeRight: { name: "rename", label: "Rename", icon: Pencil, color: colors.a1,
      onPress: () => onRename(thread) },
  };
}

function Row({
  thread,
  onRename,
  controller,
  initialSwipe,
}: {
  thread: ThreadRow;
  onRename: (t: ThreadRow) => void;
  controller: SwipeRowController;
  initialSwipe?: "left" | "right";
}) {
  const hideThread = useHideThread();
  const unhideThread = useUnhideThread();
  const remove = () => hideThread.mutate(thread.root.id, {
    onSuccess: () => toastAction("Thread removed from Inbox", "Undo", () =>
      unhideThread.mutate(thread.root.id, { onError: e => toastErr("Undo failed", e) })),
    onError: (e) => toastErr("Remove failed", e),
  });
  const onLongPress = () => {
    // Removing a thread from the inbox is per-user server-side (the
    // messages stay in the channel), so anyone may do it.
    Alert.alert("Thread", snippet(thread), [
      { text: "Rename…", onPress: () => onRename(thread) },
      { text: "Remove", style: "destructive" as const, onPress: remove },
      { text: "Cancel", style: "cancel" },
    ]);
  };
  const activityTs = threadActivityTs(thread);
  return (
    <SwipeRow
      style={[styles.row, thread.unread > 0 ? styles.rowUnread : null]}
      controller={controller} initialOpen={initialSwipe}
      accessibilityLabel={`Thread ${snippet(thread)} in ${thread.channel_name}`}
      {...threadSwipeActions(thread, onRename, remove)}
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
    >
      <View style={styles.top}>
        <Text style={styles.chan} numberOfLines={1}>
          <Text style={styles.hash}># </Text>
          {thread.channel_name}
          <Text style={styles.grp}> · {thread.group_name}</Text>
        </Text>
        <ThreadRelativeTime
          timestamp={activityTs}
          replyCount={thread.reply_count}
          lastReplyTs={thread.last_reply_ts}
        />
      </View>
      <View style={styles.mid}>
        <Text style={styles.snippet} numberOfLines={2}>{snippet(thread)}</Text>
        <Text style={styles.author} numberOfLines={1}>{thread.root.author_name || thread.root.author_id}</Text>
      </View>
      <ThreadInboxFooter
        replyCount={thread.reply_count}
        unread={thread.unread}
        lastReplyTs={thread.last_reply_ts}
      />
    </SwipeRow>
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
  groupId,
  groupOptions,
  onSort,
  onFilter,
  onGroup,
  onClose,
  initialOpen = null,
}: {
  sort: ThreadSort;
  filter: ThreadFilter;
  groupId: string | null;
  groupOptions: { id: string; name: string }[];
  onSort: (sort: ThreadSort) => void;
  onFilter: (filter: ThreadFilter) => void;
  onGroup: (groupId: string | null) => void;
  onClose: () => void;
  /** Opens a chosen menu in Storybook previews. */
  initialOpen?: "sort" | "filter" | "group" | null;
}) {
  const [open, setOpen] = React.useState<"sort" | "filter" | "group" | null>(initialOpen);
  const [controlsY, setControlsY] = React.useState(0);
  const [controlLayouts, setControlLayouts] = React.useState<Record<string, { y: number; height: number }>>({});
  const groupChoices = React.useMemo(() => [
    { value: "", label: "All groups" },
    ...groupOptions.map(group => ({ value: group.id, label: group.name })),
  ], [groupOptions]);
  const openLayout = open ? controlLayouts[open] : undefined;
  const menuOptions = open === "sort" ? SORT_OPTIONS : open === "filter" ? FILTER_OPTIONS : groupChoices;
  const wantedHeight = Math.min(220, menuOptions.length * 44 + 2);
  const rootTop = controlsY + (openLayout?.y ?? 0);
  const menuTop = open === "group"
    ? Math.max(4, rootTop - wantedHeight - 4)
    : rootTop + (openLayout?.height ?? 0) + 4;
  const menuMaxHeight = open === "group" ? Math.min(wantedHeight, Math.max(44, rootTop - 8)) : wantedHeight;
  const recordLayout = (name: "sort" | "filter" | "group") => (event: { nativeEvent: { layout: { y: number; height: number } } }) => {
    const { y, height } = event.nativeEvent.layout;
    setControlLayouts(previous => previous[name]?.y === y && previous[name]?.height === height
      ? previous : { ...previous, [name]: { y, height } });
  };

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
          <View testID="thread-view-controls" style={[styles.viewControls, styles.viewControlsContent]}
            onLayout={event => setControlsY(event.nativeEvent.layout.y)}>
            <SelectDropdown label="Sort by" value={sort} options={SORT_OPTIONS}
              menuInSheet onLayout={recordLayout("sort")}
              open={open === "sort"} onToggle={() => setOpen(open === "sort" ? null : "sort")}
              onChange={value => { onSort(value); setOpen(null); }} />
            <SelectDropdown label="Show" value={filter} options={FILTER_OPTIONS}
              menuInSheet onLayout={recordLayout("filter")}
              open={open === "filter"} onToggle={() => setOpen(open === "filter" ? null : "filter")}
              onChange={value => { onFilter(value); setOpen(null); }} />
            <SelectDropdown label="Group" value={groupId ?? ""} options={groupChoices}
              menuInSheet onLayout={recordLayout("group")}
              open={open === "group"} onToggle={() => setOpen(open === "group" ? null : "group")}
              onChange={value => { onGroup(value || null); setOpen(null); }} />
          </View>
          <Pressable accessibilityRole="button" style={styles.doneButton} onPress={onClose}>
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
          {open && openLayout ? <SelectDropdownMenu
            value={open === "sort" ? sort : open === "filter" ? filter : groupId ?? ""}
            options={menuOptions}
            style={{ top: menuTop, left: 18, right: 18, maxHeight: menuMaxHeight }}
            onToggle={() => setOpen(null)}
            onChange={value => {
              if (open === "sort") onSort(value as ThreadSort);
              else if (open === "filter") onFilter(value as ThreadFilter);
              else onGroup(value || null);
              setOpen(null);
            }} /> : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export function ThreadsScreen({ embedded = false, initialSwipe }: {
  embedded?: boolean; initialSwipe?: "left" | "right";
}) {
  const threads = useThreads();
  const swipeRows = useSwipeRows();
  const groups = useGroups();
  const [renaming, setRenaming] = React.useState<ThreadRow | null>(null);
  const [viewOptionsOpen, setViewOptionsOpen] = React.useState(false);
  const sort = usePrefs((state) => state.threadSort);
  const filter = usePrefs((state) => state.threadFilter);
  const groupId = usePrefs((state) => state.threadGroup);
  const setSort = usePrefs((state) => state.setThreadSort);
  const setFilter = usePrefs((state) => state.setThreadFilter);
  const setGroup = usePrefs((state) => state.setThreadGroup);
  const groupSelection = React.useMemo(() => resolveThreadGroupSelection({
    threads: threads.data ?? [], groups: groups.data, groupsLoaded: groups.isSuccess, selectedGroupId: groupId,
  }), [threads.data, groups.data, groups.isSuccess, groupId]);
  const effectiveGroupId = groupSelection.groupId;
  React.useEffect(() => {
    if (groupSelection.shouldClear) setGroup(null);
  }, [groupSelection.shouldClear, setGroup]);
  const displayedThreads = React.useMemo(
    () => filterAndSortThreads(threads.data ?? [], sort, filter, effectiveGroupId),
    [threads.data, sort, filter, effectiveGroupId],
  );
  const optionsActive = sort !== "recent" || filter !== "all" || effectiveGroupId !== null;
  return (
    <>
      {!embedded && <Stack.Screen options={{
        title: "Threads",
        headerShown: true,
        ...headerActions(
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Thread view options${optionsActive ? ", filters active" : ""}`}
            hitSlop={10}
            style={[styles.headerButton, optionsActive ? styles.headerButtonActive : null]}
            onPress={() => { swipeRows.close(); setViewOptionsOpen(true); }}
          >
            <Icon icon={ListFilter} size={21} color={optionsActive ? colors.a1 : colors.text} />
          </Pressable>,
        ),
      }} />}
      {embedded && <Pressable accessibilityRole="button" accessibilityLabel="Thread view options"
        style={[styles.embeddedFilters, optionsActive && styles.headerButtonActive]}
        onPress={() => { swipeRows.close(); setViewOptionsOpen(true); }}>
        <Icon icon={ListFilter} size={18} color={colors.a1} />
        <Text style={styles.embeddedFiltersText}>Thread view</Text>
      </Pressable>}
      <RenameModal thread={renaming} onClose={() => setRenaming(null)} />
      {viewOptionsOpen ? (
        <ThreadViewSheet sort={sort} filter={filter} groupId={effectiveGroupId} groupOptions={groupSelection.options}
          onSort={setSort} onFilter={setFilter} onGroup={setGroup}
          onClose={() => setViewOptionsOpen(false)} />
      ) : null}
      <FlatList
        style={styles.root}
        onScrollBeginDrag={swipeRows.close}
        contentContainerStyle={styles.content}
        data={displayedThreads}
        keyExtractor={(t) => String(t.root.id)}
        renderItem={({ item, index }) => (
          <Row thread={item} onRename={setRenaming} controller={swipeRows}
            initialSwipe={index === 0 ? initialSwipe : undefined} />
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
          ) : (threads.data?.length ?? 0) > 0 || effectiveGroupId ? (
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

export default function ThreadsRedirect() {
  return <Redirect href="/(app)/inbox?tab=threads" />;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  embeddedFilters: { minHeight: 44, alignSelf: "flex-end", flexDirection: "row", alignItems: "center", gap: 6, margin: 12, padding: 8, borderRadius: 9 },
  embeddedFiltersText: { color: colors.a1, fontWeight: weight.bold },
  headerButton: { padding: 6, borderRadius: 9 },
  headerButtonActive: { backgroundColor: colors.accentSoft },
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
  rowUnread: { borderLeftWidth: 3, borderLeftColor: colors.a1 },
  top: { flexDirection: "row", alignItems: "center", gap: 10 },
  chan: { color: colors.text, fontSize: typography.meta.fontSize, fontWeight: weight.bold, flex: 1, minWidth: 0 },
  hash: { color: colors.faint },
  grp: { color: colors.faint, fontWeight: weight.regular },
  mid: { gap: 4, paddingVertical: 4 },
  author: { ...typography.meta, color: colors.dim },
  snippet: { ...typography.body, color: colors.text, fontWeight: weight.semibold },
  empty: { alignItems: "center", paddingVertical: 60, gap: 6 },
  emptyText: { color: colors.dim, fontSize: typography.message.fontSize, fontWeight: weight.semibold },
  emptyHint: {
    color: colors.faint,
    fontSize: typography.meta.fontSize,
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
  dialogTitle: { color: colors.text, fontSize: typography.body.fontSize, fontWeight: weight.bold },
  dialogHint: { color: colors.faint, fontSize: typography.meta.fontSize },
  dialogInput: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: typography.message.fontSize,
  },
  dialogBtns: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 22,
    marginTop: 4,
  },
  dialogCancel: { color: colors.dim, fontSize: typography.message.fontSize, fontWeight: weight.semibold },
  dialogOk: { color: colors.a1, fontSize: typography.message.fontSize, fontWeight: weight.bold },
  sheetBackdropBottom: {
    flex: 1,
    backgroundColor: colors.scrim,
    justifyContent: "flex-end",
  },
  viewSheet: {
    backgroundColor: colors.sheet,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 18,
    paddingBottom: 34,
    gap: 12,
    maxHeight: "85%",
  },
  viewControls: { flexShrink: 1 },
  viewControlsContent: { gap: 12 },
  sheetHead: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  sheetTitleBlock: { flex: 1, gap: 3 },
  sheetTitle: { color: colors.text, fontSize: typography.title.fontSize, fontWeight: weight.bold },
  sheetHint: { color: colors.faint, fontSize: typography.meta.fontSize },
  doneButton: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 11,
    backgroundColor: colors.a1,
    marginTop: 2,
  },
  doneText: { color: colors.onAccent, fontSize: typography.bodySm.fontSize, fontWeight: weight.bold },
});
