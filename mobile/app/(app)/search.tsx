import { previewText } from "../../src/lib/previewText";
/* Search across groups, channels, named threads and messages. The overview
   keeps each section short; tabs open complete lists. Shared search state
   owns ordering and paging, while this screen owns navigation and Ask AI. */

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  SectionList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, router } from "expo-router";
import { Check, ChevronRight, Hash, ListFilter, MessageSquare, Paperclip, Search as SearchIcon, Sparkles, X } from "lucide-react-native";
import {
  type FileFilter,
  useAskAi,
  useGroups,
  useMe,
  searchCountLabel,
  DM_GROUP_ID,
} from "@agora/core";
import type {
  Group,
  SearchChannelHit,
  SearchGroupHit,
  SearchMessageHit,
  SearchThreadHit,
  SearchKind,
} from "@agora/core";
import { Attachments } from "../../src/components/Attachments";
import { Icon } from "../../src/components/Icon";
import { useSession } from "../../src/state/session";
import type { Session } from "@agora/core";
import { fmtTs } from "@agora/core";
import { EmptyState } from "../../src/components/EmptyState";
import { SheetHeader } from "../../src/components/SheetHeader";
import { typography, weight } from "../../src/lib/theme";
import { createThemedStyles, useAppTheme } from "../../src/lib/useTheme";

import { useSearchResults, type SearchTab } from "../../src/lib/useSearchResults";
import { toastErr } from "../../src/components/Toast";

const TAB_LABEL: Record<SearchTab, string> = {
  all: "All", groups: "Groups", channels: "Channels", threads: "Threads", messages: "Messages",
};

/** Value that lags `value` by `ms` — keeps /api/search off the hot path
    while the user is still typing. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** Active filter: one channel or one whole group, plus the chip label
    ("All of <group>" / "#<channel>"). null = everywhere. */
type Scope = { channelId?: string; groupId?: string; label: string };

/** Scope picker: "Everywhere", then each group with its channels indented.
    Hidden groups/channels are searchable too, so they're listed. */
function ScopeSheet({ groups, selected, onPick, onClose }: {
  groups: Group[];
  selected: Scope | null;
  onPick: (s: Scope | null) => void;
  onClose: () => void;
}) {
  const styles = useStyles();
  const { colors } = useAppTheme();
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLocaleLowerCase();
  const sections = groups.map(group => ({
    group,
    data: group.channels.filter(channel => !needle || group.name.toLocaleLowerCase().includes(needle)
      || channel.name.toLocaleLowerCase().includes(needle)),
  })).filter(section => !needle || section.data.length || section.group.name.toLocaleLowerCase().includes(needle));
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.keyboard} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Pressable accessible={false} style={styles.sheetBackdrop} onPress={onClose}>
        <Pressable accessible={false} accessibilityViewIsModal style={[styles.sheet, styles.scopeSheet]} onPress={event => event.stopPropagation()}>
          <SheetHeader title="Search in" onClose={onClose} />
          <View style={styles.scopeSearch}>
            <Icon icon={SearchIcon} size={16} color={colors.dim} />
            <TextInput accessibilityLabel="Find a channel" placeholder="Find a group or channel…" value={filter} onChangeText={setFilter}
              autoCapitalize="none" autoCorrect={false} placeholderTextColor={colors.faint} style={styles.scopeInput} />
          </View>
          <Pressable accessibilityRole="button" accessibilityState={{ selected: !selected }} style={styles.sheetItem} onPress={() => onPick(null)}>
            <Text style={styles.sheetItemText}>Everywhere</Text>
            {!selected ? <Icon icon={Check} size={17} color={colors.a1} /> : null}
          </Pressable>
          <SectionList style={styles.scopeList} sections={sections} stickySectionHeadersEnabled keyboardShouldPersistTaps="handled"
            keyExtractor={item => item.id}
            ListEmptyComponent={<Text style={styles.notice}>No matching groups or channels.</Text>}
            renderSectionHeader={({ section: { group } }) => (
              <Pressable accessibilityRole="button" accessibilityLabel={`All of ${group.name}`}
                accessibilityState={{ selected: selected?.groupId === group.id }} style={styles.scopeGroup}
                onPress={() => onPick({ groupId: group.id, label: `All of ${group.name}` })}>
                <Text style={styles.scopeGroupName} numberOfLines={2}>{group.name}</Text>
                <Text style={styles.scopeAll}>All</Text>
                {selected?.groupId === group.id ? <Icon icon={Check} size={17} color={colors.a1} /> : null}
              </Pressable>
            )}
            renderItem={({ item: channel }) => (
              <Pressable accessibilityRole="button" accessibilityLabel={`Search in #${channel.name}`} accessibilityState={{ selected: selected?.channelId === channel.id }}
                style={[styles.sheetItem, styles.sheetItemIndent]} onPress={() => onPick({ channelId: channel.id, label: `#${channel.name}` })}>
                <Icon icon={Hash} size={16} color={colors.dim} />
                <Text style={styles.sheetItemText} numberOfLines={2}>{channel.name}</Text>
                {selected?.channelId === channel.id ? <Icon icon={Check} size={17} color={colors.a1} /> : null}
              </Pressable>
            )} />
        </Pressable>
      </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** Attachment filter choices shown in the file-filter sheet, with their chip
    labels. `""` (Any content) is the cleared state, handled by the chip. */
const FILE_OPTS: { value: FileFilter; label: string }[] = [
  { value: "any", label: "Has files" },
  { value: "image", label: "Images" },
  { value: "pdf", label: "PDFs" },
  { value: "doc", label: "Documents" },
  { value: "video", label: "Video" },
  { value: "audio", label: "Audio" },
];
const fileLabel = (f: FileFilter): string =>
  FILE_OPTS.find((o) => o.value === f)?.label ?? "Files";

/** Attachment-filter picker, same bottom-sheet shape as ScopeSheet. */
function FileSheet({
  onPick,
  onClose,
}: {
  onPick: (f: FileFilter) => void;
  onClose: () => void;
}) {
  const styles = useStyles();
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <Pressable accessible={false} style={styles.sheetBackdrop} onPress={onClose}>
        <View accessibilityViewIsModal style={styles.sheet}>
          <SheetHeader title="Filter by attachment" onClose={onClose} />
          <ScrollView>
            <Pressable accessibilityRole="button" style={styles.sheetItem} onPress={() => onPick("")}>
              <Text style={styles.sheetItemText}>Any content</Text>
            </Pressable>
            {FILE_OPTS.map((o) => (
              <Pressable key={o.value} accessibilityRole="button" accessibilityLabel={o.label} style={styles.sheetItem} onPress={() => onPick(o.value)}>
                <Text style={styles.sheetItemText}>{o.label}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </Pressable>
    </Modal>
  );
}

type Row =
  | { kind: "ask" }
  | { kind: "header"; section: SearchKind; total: number; seeAll: boolean }
  | { kind: "group"; g: SearchGroupHit }
  | { kind: "channel"; c: SearchChannelHit }
  | { kind: "message"; m: SearchMessageHit }
  | { kind: "thread"; t: SearchThreadHit }
  | { kind: "more" }
  | { kind: "notice"; text: string };

function rowKey(r: Row): string {
  switch (r.kind) {
    case "ask":
      return "ask";
    case "header":
      return `h:${r.section}`;
    case "group":
      return `g:${r.g.id}`;
    case "channel":
      return `c:${r.c.id}`;
    case "thread":
      return `t:${r.t.id}`;
    case "message":
      return `m:${r.m.id}`;
    case "more":
      return "more";
    case "notice":
      return "notice";
  }
}

/** Same push shapes as threads.tsx / index.tsx: thread replies open the
    thread screen, everything else the channel — landing on the hit itself. */
export function openHit(m: SearchMessageHit) {
  if (m.thread_id != null) {
    router.push({
      pathname: "/(app)/thread/[channelId]/[rootId]",
      params: {
        channelId: m.channel_id,
        rootId: String(m.thread_id),
        channelName: m.channel_name,
        messageId: String(m.id),
      },
    });
  } else {
    router.push({
      pathname: "/(app)/channel/[id]",
      params: { id: m.channel_id, name: m.channel_name, groupId: m.group_id, messageId: String(m.id) },
    });
  }
}

export function openThreadHit(thread: SearchThreadHit) {
  router.push({ pathname: "/(app)/thread/[channelId]/[rootId]", params: {
    channelId: thread.channel_id, rootId: String(thread.id), channelName: thread.channel_name, groupId: thread.group_id,
  } });
}

/** Server snippets wrap matched terms in U+0001…U+0002; odd split segments
    are the matches. */
function Snippet({ text }: { text: string }) {
  const styles = useStyles();
  const parts = previewText(text).split(/[\u0001\u0002]/);
  return (
    <Text style={styles.snippet} numberOfLines={2}>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <Text key={i} style={styles.snippetHit}>
            {p}
          </Text>
        ) : (
          p
        ),
      )}
    </Text>
  );
}

function MessageRow({
  hit,
  session,
  badge,
}: {
  hit: SearchMessageHit;
  session: Session;
  badge?: number;
}) {
  const styles = useStyles();
  const atts = hit.attachments ?? [];
  return (
    <Pressable style={styles.card} onPress={() => openHit(hit)}>
      <View style={styles.cardTop}>
        {badge != null ? <Text style={styles.citeBadge}>[{badge}]</Text> : null}
        <Text style={styles.author} numberOfLines={1}>
          {hit.author_name || hit.author_id}
        </Text>
        <Text style={styles.ts}>{fmtTs(hit.ts)}</Text>
      </View>
      <Text style={styles.crumb} numberOfLines={1}>
        {hit.group_name ? `${hit.group_name} / ` : ""}
        <Text style={styles.hash}>#</Text>
        {hit.channel_name}
      </Text>
      {/* Filename-only hits come back with an empty snippet; skip the blank line. */}
      {hit.snippet ? <Snippet text={hit.snippet} /> : null}
      {atts.length > 0 ? <Attachments session={session} attachments={atts} /> : null}
    </Pressable>
  );
}

/** Answer text with [n] citations turned into taps on the nth source. */
function AnswerText({
  answer,
  sources,
}: {
  answer: string;
  sources: SearchMessageHit[];
}) {
  const styles = useStyles();
  const parts = answer.split(/(\[\d+\])/g);
  return (
    <Text style={styles.askAnswer}>
      {parts.map((p, i) => {
        const m = /^\[(\d+)\]$/.exec(p);
        const src = m ? sources[Number(m[1]) - 1] : undefined;
        if (!src) return p;
        return (
          <Text key={i} style={styles.cite} onPress={() => openHit(src)}>
            {p}
          </Text>
        );
      })}
    </Text>
  );
}

export default function SearchScreen({ initialQuery = "" }: { initialQuery?: string } = {}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const [input, setInput] = useState(initialQuery);
  const query = useDebounced(input.trim(), 250);

  /* Channel/group filter. null = everywhere. The picker lists useGroups()
     data, which is normally already cached from the home screen. */
  const [scope, setScope] = useState<Scope | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const groups = useGroups();
  const pickScope = (s: Scope | null) => {
    setScope(s);
    setScopeOpen(false);
  };

  /* Attachment filter. "" = any content; an active filter also lets the
     search run with an empty query (browse every matching attachment). */
  const [file, setFile] = useState<FileFilter>("");
  const [fileOpen, setFileOpen] = useState(false);
  const pickFile = (f: FileFilter) => {
    setFile(f);
    setFileOpen(false);
  };

  const session = useSession((s) => s.session)!;
  const search = useSearchResults(query, scope ?? undefined, file);
  const listRef = useRef<FlatList<Row>>(null);
  const selectTab = (tab: SearchTab) => { search.setTab(tab); listRef.current?.scrollToOffset({ offset: 0, animated: false }); };
  useEffect(() => { listRef.current?.scrollToOffset({ offset: 0, animated: false }); },
    [query, scope?.channelId, scope?.groupId, file, search.tab, search.sort]);
  const me = useMe();
  const ask = useAskAi();
  /* Ask-AI card. The question is snapshotted at tap time so further typing
     doesn't change what the card claims to answer. */
  const [askQuestion, setAskQuestion] = useState<string | null>(null);
  const closeAsk = () => {
    setAskQuestion(null);
    ask.reset();
  };
  const startAsk = () => {
    const q = input.trim();
    if (!q) return;
    setAskQuestion(q);
    ask.mutate({ q, scope: scope ?? undefined });
  };

  const showAsk = !!me.data?.search_ai && input.trim().length > 0 && search.tab === "all";
  const rows = useMemo<Row[]>(() => {
    if (!search.active) return [];
    const out: Row[] = [];
    if (showAsk) out.push({ kind: "ask" });
    if (search.isError) {
      out.push({ kind: "notice", text: `Search failed: ${search.error?.message || "Please try again."}` });
      return out;
    }
    if (!search.ready) return out;
    const heading = (section: SearchKind) => out.push({ kind: "header", section, total: search.totals[section], seeAll: search.seeAll[section] });
    if (search.groups.length) { heading("groups"); search.groups.forEach(g => out.push({ kind: "group", g })); }
    if (search.channels.length) { heading("channels"); search.channels.forEach(c => out.push({ kind: "channel", c })); }
    if (search.threads.length) { heading("threads"); search.threads.forEach(t => out.push({ kind: "thread", t })); }
    if (search.messages.length) { heading("messages"); search.messages.forEach(m => out.push({ kind: "message", m })); }
    if (search.hasMore) out.push({ kind: "more" });
    if (!search.groups.length && !search.channels.length && !search.threads.length && !search.messages.length) {
      const where = scope ? ` in ${scope.label}` : "";
      out.push({ kind: "notice", text: query
        ? `No ${search.tab === "all" ? "results" : TAB_LABEL[search.tab].toLowerCase()} for “${query}”${where}`
        : `No messages with ${fileLabel(file).toLowerCase()}${where}` });
    }
    return out;
  }, [query, scope, file, showAsk, search]);

  const onMore = () => search.loadMore({ onError: error => toastErr("Couldn't load more results", error) });

  const renderRow = ({ item }: { item: Row }) => {
    switch (item.kind) {
      case "ask":
        return (
          <Pressable style={styles.askRow} onPress={startAsk}>
            <Icon icon={Sparkles} size={17} color={colors.a1} />
            <Text style={styles.askRowText} numberOfLines={1}>
              Ask Agora AI: <Text style={styles.askRowQuery}>{input.trim()}</Text>
            </Text>
          </Pressable>
        );
      case "header":
        return <View style={styles.sectionHead}>
          <Text accessibilityRole="header" style={styles.section}>{TAB_LABEL[item.section]} <Text style={styles.sectionCount}>{searchCountLabel(item.section, item.total)}</Text></Text>
          {item.seeAll ? <Pressable accessibilityRole="button" accessibilityLabel={`See all ${TAB_LABEL[item.section].toLowerCase()}`}
            style={styles.seeAll} onPress={() => selectTab(item.section)}>
            <Text style={styles.moreText}>See all</Text><Icon icon={ChevronRight} size={16} color={colors.a1} />
          </Pressable> : null}
        </View>;
      case "group":
        return (
          <Pressable
            style={styles.card}
            onPress={() =>
              router.push({
                pathname: "/(app)/members/[groupId]",
                params: { groupId: item.g.id, name: item.g.name },
              })
            }
          >
            <Text style={styles.title} numberOfLines={1}>
              {item.g.name}
            </Text>
            {item.g.description ? (
              <Text style={styles.sub} numberOfLines={1}>
                {item.g.description}
              </Text>
            ) : null}
          </Pressable>
        );
      case "channel":
        return (
          <Pressable
            style={styles.card}
            onPress={() =>
              router.push({
                pathname: "/(app)/channel/[id]",
                params: { id: item.c.id, name: item.c.name, groupId: item.c.group_id },
              })
            }
          >
            <Text style={styles.title} numberOfLines={1}>
              <Text style={styles.hash}># </Text>
              {item.c.name}
              {item.c.group_name ? (
                <Text style={styles.crumbSuffix}> · {item.c.group_name}</Text>
              ) : null}
            </Text>
            {item.c.topic ? (
              <Text style={styles.sub} numberOfLines={1}>
                {item.c.topic}
              </Text>
            ) : null}
          </Pressable>
        );
      case "thread":
        return <Pressable accessibilityRole="button" accessibilityLabel={`Open thread: ${item.t.alias}`}
          style={styles.card} onPress={() => openThreadHit(item.t)}>
          <View style={styles.threadTitle}><Icon icon={MessageSquare} size={16} color={colors.a1} />
            <Text style={[styles.title, styles.flex]} numberOfLines={2}>{item.t.alias}</Text></View>
          <Text style={styles.crumb} numberOfLines={1}>{item.t.group_id === DM_GROUP_ID || !item.t.group_id
            ? `${item.t.channel_name} · Direct messages` : `#${item.t.channel_name} · ${item.t.group_name}`}</Text>
          <View style={styles.cardTop}>
            <Text style={[styles.sub, styles.flex]}>{item.t.reply_count} {item.t.reply_count === 1 ? "reply" : "replies"}</Text>
            <Text style={styles.ts}>{fmtTs(item.t.last_activity)}</Text>
          </View>
        </Pressable>;
      case "message":
        return <MessageRow hit={item.m} session={session} />;
      case "more":
        return (
          <Pressable accessibilityRole="button" accessibilityLabel="More results" style={styles.moreRow} onPress={onMore} disabled={search.loadingMore}>
            {search.loadingMore ? (
              <ActivityIndicator size="small" color={colors.dim} />
            ) : (
              <Text style={styles.moreText}>More results</Text>
            )}
          </Pressable>
        );
      case "notice":
        return <View><Text style={styles.notice}>{item.text}</Text>
          {search.isError ? <Pressable accessibilityRole="button" accessibilityLabel="Retry search" style={styles.moreRow} onPress={search.refetch}>
            <Text style={styles.moreText}>Try again</Text></Pressable> : null}</View>;
    }
  };

  const askSources = ask.data?.sources ?? [];

  return (
    <>
      <Stack.Screen options={{ title: "Search", headerShown: true }} />
      <View style={styles.root}>
        <View style={styles.searchRow}>
          <Icon icon={SearchIcon} size={17} color={colors.faint} />
          <TextInput
            style={styles.searchInput}
            value={input}
            onChangeText={setInput}
            accessibilityLabel="Search conversations"
            placeholder="Search messages, threads, channels…"
            placeholderTextColor={colors.faint}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {search.isLoading || search.isRefetching ? (
            <ActivityIndicator size="small" color={colors.dim} />
          ) : input.length > 0 ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setInput("")} hitSlop={8}>
              <Icon icon={X} size={16} color={colors.dim} />
            </Pressable>
          ) : null}
        </View>
        <View style={styles.filterRow}>
          <Pressable
            accessibilityRole="button" accessibilityLabel="Search scope"
            style={[styles.filterChip, scope ? styles.filterChipActive : null]}
            onPress={() => setScopeOpen(true)}
          >
            <Icon icon={ListFilter} size={14} color={scope ? colors.a1 : colors.dim} />
            <Text
              style={[styles.filterChipText, scope ? styles.filterChipTextActive : null]}
              numberOfLines={1}
            >
              {scope ? scope.label : "Everywhere"}
            </Text>
            {scope ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Clear search scope" onPress={event => { event.stopPropagation(); setScope(null); }} hitSlop={8}>
                <Icon icon={X} size={13} color={colors.a1} />
              </Pressable>
            ) : null}
          </Pressable>
          <Pressable
            accessibilityRole="button" accessibilityLabel="Filter by attachment"
            style={[styles.filterChip, file ? styles.filterChipActive : null]}
            onPress={() => setFileOpen(true)}
          >
            <Icon icon={Paperclip} size={14} color={file ? colors.a1 : colors.dim} />
            <Text
              style={[styles.filterChipText, file ? styles.filterChipTextActive : null]}
              numberOfLines={1}
            >
              {file ? fileLabel(file) : "Any content"}
            </Text>
            {file ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Clear attachment filter" onPress={event => { event.stopPropagation(); setFile(""); }} hitSlop={8}>
                <Icon icon={X} size={13} color={colors.a1} />
              </Pressable>
            ) : null}
          </Pressable>
        </View>
        {search.active && askQuestion == null ? <View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}
            keyboardShouldPersistTaps="handled" accessibilityRole="tablist">
            {search.tabs.map(tab => <Pressable key={tab} accessibilityRole="tab" accessibilityLabel={TAB_LABEL[tab]}
              accessibilityState={{ selected: search.tab === tab }}
              accessibilityValue={tab === "all" ? undefined : { text: `${searchCountLabel(tab, search.totals[tab])} results` }} style={[styles.tab, search.tab === tab && styles.tabSelected]}
              onPress={() => selectTab(tab)}>
              <Text style={[styles.tabText, search.tab === tab && styles.tabTextSelected]}>{TAB_LABEL[tab]}</Text>
              {tab !== "all" ? <Text style={[styles.tabCount, search.tab === tab && styles.tabTextSelected]}>{searchCountLabel(tab, search.totals[tab])}</Text> : null}
            </Pressable>)}
          </ScrollView>
          {search.canSort ? <View style={styles.sortRow}>
            <Text style={styles.sortLabel}>Messages</Text>
            <View style={styles.sortControl}>
              {(["", "new"] as const).map(sort => <Pressable key={sort || "relevance"} accessibilityRole="button"
                accessibilityLabel={sort ? "Newest first" : "Best match"} accessibilityState={{ selected: search.sort === sort }}
                style={[styles.sortOption, search.sort === sort && styles.sortSelected]} onPress={() => search.setSort(sort)}>
                <Text style={[styles.tabText, search.sort === sort && styles.tabTextSelected]}>{sort ? "Newest" : "Best match"}</Text>
              </Pressable>)}
            </View>
          </View> : null}
        </View> : null}
        {scopeOpen ? (
          <ScopeSheet
            groups={groups.data ?? []}
            selected={scope}
            onPick={pickScope}
            onClose={() => setScopeOpen(false)}
          />
        ) : null}
        {fileOpen ? (
          <FileSheet onPick={pickFile} onClose={() => setFileOpen(false)} />
        ) : null}
        {askQuestion != null ? (
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={styles.askCard}>
              <View style={styles.askHead}>
                <Icon icon={Sparkles} size={16} color={colors.a1} />
                <Text style={styles.askTitle} numberOfLines={2}>
                  {askQuestion}
                </Text>
                <Pressable onPress={closeAsk} hitSlop={10}>
                  <Icon icon={X} size={18} color={colors.dim} />
                </Pressable>
              </View>
              {ask.isPending ? (
                <View style={styles.askThinking}>
                  <ActivityIndicator size="small" color={colors.a1} />
                  <Text style={styles.askThinkingText}>Thinking…</Text>
                </View>
              ) : ask.isError ? (
                <Text style={styles.askError}>{ask.error.message}</Text>
              ) : ask.data ? (
                ask.data.answer ? (
                  <AnswerText answer={ask.data.answer} sources={askSources} />
                ) : (
                  <Text style={styles.notice}>
                    {ask.data.detail || "No matching messages to answer from."}
                  </Text>
                )
              ) : null}
            </View>
            {askSources.length > 0 ? (
              <>
                <Text style={styles.section}>Sources</Text>
                {askSources.map((s, i) => (
                  <MessageRow key={`${s.id}:${i}`} hit={s} session={session} badge={i + 1} />
                ))}
              </>
            ) : null}
          </ScrollView>
        ) : (
          <FlatList
            ref={listRef}
            style={styles.list}
            contentContainerStyle={styles.content}
            data={rows}
            keyExtractor={rowKey}
            renderItem={renderRow}
            refreshing={search.isRefetching}
            onRefresh={search.active ? search.refetch : undefined}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            ListEmptyComponent={
              search.isLoading ? <View style={styles.loading}><ActivityIndicator color={colors.a1} /><Text style={styles.sub}>Searching…</Text></View> : query || file ? null : (
                <EmptyState icon={SearchIcon} title="Find a conversation"
                  description="Search messages, named threads, channels and groups, or filter by attachment." />
              )
            }
          />
        )}
      </View>
    </>
  );
}

const useStyles = createThemedStyles(({ colors, surfaces }) => ({
  root: { flex: 1, backgroundColor: colors.bg },
  list: { flex: 1 },
  flex: { flex: 1 },
  keyboard: { flex: 1 },
  loading: { alignItems: "center", gap: 12, padding: 24 },
  tabs: { paddingHorizontal: 14, paddingVertical: 10, gap: 6 },
  tab: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, borderRadius: 12 },
  tabSelected: { backgroundColor: colors.accentSoft },
  tabText: { ...typography.bodySm, color: colors.dim, fontWeight: weight.semibold },
  tabTextSelected: { color: colors.accentText },
  tabCount: { ...typography.caption, color: colors.faint },
  sortRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8, marginHorizontal: 14, paddingBottom: 8 },
  sortLabel: { ...typography.caption, color: colors.dim },
  sortControl: { flexDirection: "row", padding: 3, borderRadius: 12, backgroundColor: colors.panelStrong },
  sortOption: { minHeight: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: 12, borderRadius: 9 },
  sortSelected: { backgroundColor: colors.panel },
  sectionHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44, gap: 8 },
  sectionCount: { color: colors.dim },
  seeAll: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 4 },
  threadTitle: { flexDirection: "row", alignItems: "center", gap: 8 },
  scopeSheet: { height: "70%" },
  scopeList: { flex: 1 },
  scopeSearch: { flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 10, backgroundColor: colors.panelStrong, paddingHorizontal: 12 },
  scopeInput: { flex: 1, minHeight: 44, ...typography.bodySm, color: colors.text },
  scopeGroup: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10, minHeight: 44, backgroundColor: colors.sheet },
  scopeGroupName: { flex: 1, ...typography.bodySm, fontWeight: weight.semibold, color: colors.text },
  scopeAll: { ...typography.caption, color: colors.accentText },
  content: { padding: 14, gap: 10, paddingBottom: 40 },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 14,
    marginTop: 10,
    backgroundColor: colors.panelStrong,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontSize: typography.message.fontSize,
    paddingVertical: 9,
  },
  filterRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginHorizontal: 14,
    marginTop: 8,
  },
  filterChip: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    paddingHorizontal: 11,
    paddingVertical: 6,
    maxWidth: "100%",
  },
  filterChipActive: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.accentBorder,
  },
  filterChipText: {
    color: colors.dim,
    fontSize: typography.meta.fontSize,
    fontWeight: weight.bold,
    flexShrink: 1,
  },
  filterChipTextActive: { color: colors.a1 },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: colors.scrim,
    justifyContent: "flex-end",
  },
  sheet: {
    ...surfaces.sheet,
    gap: 4,
    paddingBottom: 34,
    maxHeight: "70%",
  },
  sheetItem: {
    flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  sheetItemIndent: { paddingLeft: 18 },
  sheetItemText: { flex: 1, color: colors.text, fontSize: typography.message.fontSize },
  section: {
    color: colors.faint,
    fontSize: typography.caption.fontSize,
    fontWeight: weight.bold,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginTop: 6,
  },
  card: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 11,
    gap: 3,
  },
  cardTop: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  title: { color: colors.text, fontSize: typography.message.fontSize, fontWeight: weight.bold },
  sub: { color: colors.dim, fontSize: typography.meta.fontSize },
  hash: { color: colors.faint },
  crumbSuffix: { color: colors.faint, fontWeight: weight.regular, fontSize: typography.meta.fontSize },
  author: { color: colors.a1, fontSize: typography.meta.fontSize, fontWeight: weight.bold, flex: 1 },
  ts: { color: colors.faint, fontSize: typography.caption.fontSize },
  crumb: { color: colors.faint, fontSize: typography.caption.fontSize },
  snippet: { color: colors.dim, fontSize: typography.bodySm.fontSize, lineHeight: 19 },
  snippetHit: { color: colors.a1, fontWeight: weight.bold },
  moreRow: { minHeight: 48, justifyContent: "center", alignItems: "center", paddingVertical: 10 },
  moreText: { color: colors.a1, fontSize: typography.bodySm.fontSize, fontWeight: weight.bold },
  notice: { color: colors.dim, fontSize: typography.bodySm.fontSize, textAlign: "center", paddingVertical: 24 },
  askRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  askRowText: { color: colors.text, fontSize: typography.bodySm.fontSize, fontWeight: weight.bold, flex: 1 },
  askRowQuery: { color: colors.a1 },
  askCard: {
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  askHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  askTitle: { color: colors.text, fontSize: typography.message.fontSize, fontWeight: weight.bold, flex: 1 },
  askThinking: { flexDirection: "row", alignItems: "center", gap: 10 },
  askThinkingText: { color: colors.dim, fontSize: typography.bodySm.fontSize },
  askAnswer: { color: colors.text, fontSize: typography.message.fontSize, lineHeight: 21 },
  askError: { color: colors.red, fontSize: typography.bodySm.fontSize },
  cite: { color: colors.a1, fontWeight: weight.bold },
  citeBadge: { color: colors.a1, fontSize: typography.caption.fontSize, fontWeight: weight.bold },
}));
