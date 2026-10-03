import { previewText } from "../../src/lib/previewText";
/* Search: one box over groups / channels / messages, mirroring the desktop
   search pane. Message hits show a snippet with the matched terms
   highlighted; tapping a hit opens its channel (or thread — deep-linking to
   the exact message is out of scope). When the server has an Anthropic key
   (me.search_ai), an "Ask Agora AI" row answers questions from history with
   [n] citations into a tappable source list. */

import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, router } from "expo-router";
import { ListFilter, Paperclip, Search as SearchIcon, Sparkles, X } from "lucide-react-native";
import {
  type FileFilter,
  useAskAi,
  useGroups,
  useMe,
  useSearch,
  useSearchMore,
} from "@agora/core";
import type {
  Group,
  SearchChannelHit,
  SearchGroupHit,
  SearchMessageHit,
} from "@agora/core";
import { Attachments } from "../../src/components/Attachments";
import { Icon } from "../../src/components/Icon";
import { useSession } from "../../src/state/session";
import type { Session } from "@agora/core";
import { fmtTs } from "@agora/core";
import { EmptyState } from "../../src/components/EmptyState";
import { SheetHeader } from "../../src/components/SheetHeader";
import { colors, typography, weight, surfaces } from "../../src/lib/theme";

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
function ScopeSheet({
  groups,
  onPick,
  onClose,
}: {
  groups: Group[];
  onPick: (s: Scope | null) => void;
  onClose: () => void;
}) {
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <Pressable accessible={false} style={styles.sheetBackdrop} onPress={onClose}>
        <View accessibilityViewIsModal style={styles.sheet}>
          <SheetHeader title="Search in" onClose={onClose} />
          <ScrollView>
            <Pressable accessibilityRole="button" style={styles.sheetItem} onPress={() => onPick(null)}>
              <Text style={styles.sheetItemText}>Everywhere</Text>
            </Pressable>
            {groups.map((g) => (
              <React.Fragment key={g.id}>
                <Pressable
                  accessibilityRole="button" style={styles.sheetItem}
                  onPress={() => onPick({ groupId: g.id, label: `All of ${g.name}` })}
                >
                  <Text style={styles.sheetItemText}>All of {g.name}</Text>
                </Pressable>
                {g.channels.map((c) => (
                  <Pressable
                    key={c.id}
                    accessibilityRole="button" style={[styles.sheetItem, styles.sheetItemIndent]}
                    onPress={() => onPick({ channelId: c.id, label: `#${c.name}` })}
                  >
                    <Text style={styles.sheetItemText}>
                      <Text style={styles.hash}># </Text>
                      {c.name}
                    </Text>
                  </Pressable>
                ))}
              </React.Fragment>
            ))}
          </ScrollView>
        </View>
      </Pressable>
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
              <Pressable key={o.value} accessibilityRole="button" style={styles.sheetItem} onPress={() => onPick(o.value)}>
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
  | { kind: "header"; title: string }
  | { kind: "group"; g: SearchGroupHit }
  | { kind: "channel"; c: SearchChannelHit }
  | { kind: "message"; m: SearchMessageHit }
  | { kind: "more" }
  | { kind: "notice"; text: string };

function rowKey(r: Row): string {
  switch (r.kind) {
    case "ask":
      return "ask";
    case "header":
      return `h:${r.title}`;
    case "group":
      return `g:${r.g.id}`;
    case "channel":
      return `c:${r.c.id}`;
    case "message":
      return `m:${r.m.id}`;
    case "more":
      return "more";
    case "notice":
      return "notice";
  }
}

/** Same push shapes as threads.tsx / index.tsx: thread replies open the
    thread screen, everything else the channel. */
function openHit(m: SearchMessageHit) {
  if (m.thread_id != null) {
    router.push({
      pathname: "/(app)/thread/[channelId]/[rootId]",
      params: {
        channelId: m.channel_id,
        rootId: String(m.thread_id),
        channelName: m.channel_name,
      },
    });
  } else {
    router.push({
      pathname: "/(app)/channel/[id]",
      params: { id: m.channel_id, name: m.channel_name, groupId: m.group_id },
    });
  }
}

/** Server snippets wrap matched terms in U+0001…U+0002; odd split segments
    are the matches. */
function Snippet({ text }: { text: string }) {
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

export default function SearchScreen() {
  const [input, setInput] = useState("");
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
  const search = useSearch(query, scope ?? undefined, file);
  const me = useMe();
  const ask = useAskAi();
  const searchMore = useSearchMore();

  /* "More results" pages, appended below the base page. Raw (un-deduped) so
     `offset` stays a plain count of rows fetched; render dedupes by id.
     A scope change re-scopes the base page, so it resets these too. */
  const [extra, setExtra] = useState<SearchMessageHit[]>([]);
  const [extraHasMore, setExtraHasMore] = useState<boolean | null>(null);
  useEffect(() => {
    setExtra([]);
    setExtraHasMore(null);
  }, [query, scope, file]);

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

  const data = search.data;
  const groupHits = data?.groups ?? [];
  const channelHits = data?.channels ?? [];
  const baseMessages = useMemo(() => data?.messages?.items ?? [], [data]);
  const messages = useMemo(() => {
    if (extra.length === 0) return baseMessages;
    const seen = new Set(baseMessages.map((m) => m.id));
    const out = [...baseMessages];
    for (const m of extra) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        out.push(m);
      }
    }
    return out;
  }, [baseMessages, extra]);
  const hasMore = extraHasMore ?? data?.messages?.has_more ?? false;
  const showAsk = !!me.data?.search_ai && input.trim().length > 0;

  const rows = useMemo<Row[]>(() => {
    // A file filter alone (empty query) is a valid "browse files" search.
    if (!query && !file) return [];
    const out: Row[] = [];
    if (showAsk) out.push({ kind: "ask" });
    if (search.isError) {
      out.push({ kind: "notice", text: `Search failed: ${search.error.message}` });
      return out;
    }
    if (!data) return out; // first fetch in flight — header spinner covers it
    if (groupHits.length > 0) {
      out.push({ kind: "header", title: "Groups" });
      for (const g of groupHits) out.push({ kind: "group", g });
    }
    if (channelHits.length > 0) {
      out.push({ kind: "header", title: "Channels" });
      for (const c of channelHits) out.push({ kind: "channel", c });
    }
    if (messages.length > 0) {
      out.push({ kind: "header", title: "Messages" });
      for (const m of messages) out.push({ kind: "message", m });
      if (hasMore) out.push({ kind: "more" });
    }
    if (groupHits.length + channelHits.length + messages.length === 0) {
      const where = scope ? ` in ${scope.label}` : "";
      out.push({
        kind: "notice",
        text: query
          ? `No results for “${query}”${where}`
          : `No messages with ${fileLabel(file).toLowerCase()}${where}`,
      });
    }
    return out;
  }, [query, scope, file, showAsk, search.isError, search.error, data, groupHits, channelHits, messages, hasMore]);

  const onMore = () => {
    if (searchMore.isPending) return;
    const base = data?.messages;
    if (!base) return;
    const offset = base.offset + base.items.length + extra.length;
    searchMore.mutate(
      { q: query, offset, scope: scope ?? undefined, file },
      {
        onSuccess: (page) => {
          if (!page) return;
          setExtra((prev) => [...prev, ...page.items]);
          setExtraHasMore(page.has_more);
        },
      },
    );
  };

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
        return <Text style={styles.section}>{item.title}</Text>;
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
      case "message":
        return <MessageRow hit={item.m} session={session} />;
      case "more":
        return (
          <Pressable style={styles.moreRow} onPress={onMore} disabled={searchMore.isPending}>
            {searchMore.isPending ? (
              <ActivityIndicator size="small" color={colors.dim} />
            ) : (
              <Text style={styles.moreText}>More results</Text>
            )}
          </Pressable>
        );
      case "notice":
        return <Text style={styles.notice}>{item.text}</Text>;
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
            placeholder="Search messages, channels, groups"
            placeholderTextColor={colors.faint}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {search.isFetching ? (
            <ActivityIndicator size="small" color={colors.dim} />
          ) : input.length > 0 ? (
            <Pressable onPress={() => setInput("")} hitSlop={8}>
              <Icon icon={X} size={16} color={colors.dim} />
            </Pressable>
          ) : null}
        </View>
        <View style={styles.filterRow}>
          <Pressable
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
              <Pressable onPress={() => setScope(null)} hitSlop={8}>
                <Icon icon={X} size={13} color={colors.a1} />
              </Pressable>
            ) : null}
          </Pressable>
          <Pressable
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
              <Pressable onPress={() => setFile("")} hitSlop={8}>
                <Icon icon={X} size={13} color={colors.a1} />
              </Pressable>
            ) : null}
          </Pressable>
        </View>
        {scopeOpen ? (
          <ScopeSheet
            groups={groups.data ?? []}
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
            style={styles.list}
            contentContainerStyle={styles.content}
            data={rows}
            keyExtractor={rowKey}
            renderItem={renderRow}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            ListEmptyComponent={
              query || file ? null : (
                <EmptyState icon={SearchIcon} title="Find a conversation"
                  description="Search message history, channels and groups, or filter by attachment." />
              )
            }
          />
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  list: { flex: 1 },
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
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  sheetItemIndent: { paddingLeft: 18 },
  sheetItemText: { color: colors.text, fontSize: typography.message.fontSize },
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
  moreRow: { alignItems: "center", paddingVertical: 10 },
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
});
