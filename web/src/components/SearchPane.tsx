/* Search overlay (⌘K): live
   results (groups/channels/threads/messages) with keyboard navigation, scope
   and attachment filters, an overview that caps each kind at a few rows with
   "See all" into one kind's full, paged list, a best-match/newest toggle for
   messages, and the Ask-AI answer view with [n] citations. */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  currentPlatform, formatCombo, SHORTCUTS, shortcutAvailable, esc, mdliteHtml, fmtTs, SEARCH_PAGE, useAskAi, useGroups, useMe, useSearch,
  useSearchKindMore, useSearchMore,
  type AskResponse, type FileFilter, type SearchChannelHit, type SearchGroupHit, type SearchKind, type SearchMessageHit,
  type SearchScope, type SearchSort, type SearchThreadHit,
} from "@agora/core";
import { Icon } from "../lib/icons";
import { appendUnique, moreAfterPage } from "../lib/searchPages";
import { SearchPicker, type PickerOption } from "./SearchPicker";
import { fileUrl, humanSize } from "../lib/files";
import { toast } from "../lib/toast";
import { useJump } from "../state/jump";
import { DM_GROUP_ID, useUiState } from "../state/ui";
import { isTopDialog, useDialogFocus } from "../hooks/useDialogFocus";
import { isDesktopShell } from "../lib/chime";
import { bindingFor, useShortcutState } from "../state/shortcuts";

type Item =
  | { kind: "command"; id: string }
  | { kind: "ask" }
  | { kind: "group"; g: SearchGroupHit }
  | { kind: "channel"; c: SearchChannelHit }
  | { kind: "thread"; t: SearchThreadHit }
  | { kind: "message"; m: SearchMessageHit }
  | { kind: "seeall"; tab: SearchKind }
  | { kind: "more" };

/** "all" is the overview; the rest list one kind in full. */
type Tab = "all" | SearchKind;

/** Rows per kind in the overview, so every section keeps a fixed height and
    one busy kind can't push the others out of view. */
const OVERVIEW_ROWS = 4;
/** The server counts message hits to one past this, then stops. */
const TOTAL_CAP = 1000;

const TAB_LABELS: Record<Tab, string> = {
  all: "All", groups: "Groups", channels: "Channels", threads: "Threads", messages: "Messages",
};

/** Only message totals stop at the server's cap (counting one past it, so
    exactly 1,000 still reads "1,000"); other kinds are exact. */
function countLabel(kind: SearchKind, n: number): string {
  return kind === "messages" && n > TOTAL_CAP ? `${TOTAL_CAP.toLocaleString()}+` : n.toLocaleString();
}

const FILE_OPTIONS: PickerOption[] = [
  { value: "", label: "Any content", icon: "layout-grid" },
  { value: "any", label: "Has files", icon: "paperclip" },
  { value: "image", label: "Images", icon: "image" },
  { value: "pdf", label: "PDFs", icon: "file-text" },
  { value: "doc", label: "Documents", icon: "file-text" },
  { value: "video", label: "Video", icon: "maximize-2" },
  { value: "audio", label: "Audio", icon: "volume-2" },
];

/* Matched terms arrive wrapped in U+0001…U+0002 — escape first, then turn
   the markers into the highlight span. */
function snippetHTML(s: string): string {
  return esc(s)
    .replace(//g, '<span class="ago-search-hl">')
    .replace(//g, "</span>");
}

function pinSnippet(m: { alias?: string | null; text?: string }): string {
  const alias = (m.alias || "").trim();
  if (alias) return alias;
  return (m.text || "").split("\n")[0].slice(0, 140);
}

/* [n] citations become superscript links; the pre/code/link split keeps
   code blocks untouched. */
function answerHTML(answer: string, nSources: number): string {
  return mdliteHtml(answer)
    .split(/(<pre[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>|<a\b[\s\S]*?<\/a>)/)
    .map((seg, i) => i % 2 ? seg : seg.replace(/\[(\d{1,2})\]/g, (all, nRaw) => {
      const n = Number(nRaw);
      if (n < 1 || n > nSources) return all;
      return `<sup class="ago-search-cite"><a href="#" data-cite="${n}" title="Jump to source ${n}">[${n}]</a></sup>`;
    }))
    .join("");
}

function MsgRow({ m, num, sel, onClick }: {
  m: SearchMessageHit; num: number; sel: boolean; onClick: () => void;
}) {
  const crumb = `${m.group_name || ""} / #${m.channel_name || ""}`;
  const snippet = m.snippet ? snippetHTML(m.snippet) : esc(pinSnippet(m));
  return (
    <div className={`ago-search-row msg${sel ? " sel" : ""}`} title="Jump to message" onClick={onClick}>
      <div className="ago-search-msg-top">
        {num ? <span className="ago-search-srcn">{num}</span> : null}
        <span className="ago-search-author">{m.author_name || m.author_id}</span>
        <span className="ago-search-crumb">{crumb}{m.thread_id != null ? " · in thread" : ""}</span>
        <span className="ago-search-ts">{fmtTs(m.ts)}</span>
      </div>
      {snippet ? <div className="ago-search-snippet" dangerouslySetInnerHTML={{ __html: snippet }} /> : null}
      {(m.attachments || []).length > 0 && (
        <div className="ago-atts">
          {(m.attachments || []).map(f => (
            <a key={f.id} className="ago-att-file" href={fileUrl(f.id)} download={f.filename}
              target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
              title={`Download ${f.filename}`}>
              <span className="ago-file-icon">
                <Icon name={(f.mime || "").startsWith("image/") ? "image" : "file-text"} />
              </span>
              <span className="ago-file-meta">
                <span className="fname">{f.filename}</span>
                <span className="fsize">{humanSize(f.size)}</span>
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function ThreadRow({ t, sel, onClick }: { t: SearchThreadHit; sel: boolean; onClick: () => void }) {
  const replies = t.reply_count === 1 ? "1 reply" : `${t.reply_count.toLocaleString()} replies`;
  // An agent DM is named after the agent, not a #channel in a group.
  const where = t.group_id === DM_GROUP_ID ? `${t.channel_name} · ${t.group_name}` : `${t.group_name || ""} / #${t.channel_name || ""}`;
  return (
    <div className={`ago-search-row thread${sel ? " sel" : ""}`} title="Open thread" onClick={onClick}>
      <span className="ago-search-ico"><Icon name="message-circle" /></span>
      <span className="ago-search-name ago-search-thread-name">{t.alias}</span>
      <span className="ago-search-crumb">{`${where} · ${replies}`}</span>
      <span className="ago-search-ts">{fmtTs(t.last_activity)}</span>
    </div>
  );
}

const FILE_LABELS: Record<string, string> = {
  any: "attachments", image: "images", pdf: "PDFs", doc: "documents",
  video: "video", audio: "audio",
};

export function SearchPane() {
  const ui = useUiState();
  const me = useMe().data;
  const groups = useGroups().data || [];
  useShortcutState(s => s.bindings);
  const [query, setQuery] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [scopeStr, setScopeStr] = useState("");
  const [file, setFile] = useState<FileFilter>("");
  const [sel, setSel] = useState(0);
  const [view, setView] = useState<"results" | "ask">("results");
  const [answer, setAnswer] = useState<AskResponse | "loading" | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  // The Messages tab's order, and the overview's. The overview's changes
  // only when the toggle is used on All, so switching tabs never changes its
  // query (and never refetches it); toggling on Messages reorders just that
  // tab.
  const [sort, setSort] = useState<SearchSort>("");
  const [overviewSort, setOverviewSort] = useState<SearchSort>("");
  // Pages loaded past the first by "More results", for the open tab only.
  const [extra, setExtra] = useState<SearchMessageHit[]>([]);
  const [extraSide, setExtraSide] = useState<(SearchChannelHit | SearchGroupHit | SearchThreadHit)[]>([]);
  // Whether the open tab's latest extra page leaves more to load; null
  // until "More results" ran (the first page decides until then).
  const [morePages, setMorePages] = useState<boolean | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const askAi = useAskAi();
  const more = useSearchMore();
  const moreSide = useSearchKindMore();
  /** Accumulated pages belong to one query, scope, filter, sort and tab:
      each reset starts a new generation, and a page that arrives for an
      older one is dropped rather than appended to the wrong list. */
  const pageGen = useRef(0);
  // Rows the extra pages returned, duplicates included: the next offset.
  // The ref is current the moment a page lands (the state, for render, a
  // render later), and one page request runs at a time, so a quick second
  // "More results" can neither reuse an offset nor skip rows.
  const [fetched, setFetched] = useState(0);
  const fetchedRef = useRef(0);
  const pageInFlight = useRef(false);
  const resetPages = () => {
    pageGen.current += 1; fetchedRef.current = 0; pageInFlight.current = false;
    setExtra([]); setExtraSide([]); setFetched(0); setMorePages(null); setSel(0);
  };
  const panelRef = useDialogFocus(ui.searchOpen, () => {
    if (view === "ask") { setView("results"); setAnswer(null); setSel(0); inputRef.current?.focus(); }
    else ui.setSearchOpen(false);
  });

  const scope: SearchScope | undefined = scopeStr.startsWith("g:")
    ? { groupId: scopeStr.slice(2) }
    : scopeStr.startsWith("c:") ? { channelId: scopeStr.slice(2) } : undefined;
  // The overview always loads (its totals label the tabs); an open tab loads
  // its one kind. On the overview the second call passes the overview's own
  // arguments, so both share one cached query rather than searching twice.
  // Sort orders messages only: the overview's own, and a tab's list only on
  // the Messages tab. The overview asks for one row past what it shows per
  // kind; totals and has_more drive See all.
  const overviewOpts = { overview: true, sort: overviewSort, limit: OVERVIEW_ROWS + 1 } as const;
  const overview = useSearch(debouncedQ, scope, file, overviewOpts);
  const tabRes = useSearch(debouncedQ, scope, file,
    tab === "all" ? overviewOpts : { kind: tab, sort: tab === "messages" ? sort : "" });
  // A tab just opened shows the previous query's (or kind's) rows as
  // placeholder data; treat that as still loading rather than as its list.
  const tabPending = tab !== "all" && tabRes.isPlaceholderData;
  const res = tab === "all" ? overview : tabRes;
  const resData = tabPending ? undefined : res.data;

  // 250ms input debounce.
  useEffect(() => {
    const t = setTimeout(() => { setDebouncedQ(query.trim()); resetPages(); }, 250);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (ui.searchOpen) {
      setView("results");
      setAnswer(null);
      setTab("all");
      setSort("");
      setOverviewSort("");
      resetPages();
      setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 0);
    }
  }, [ui.searchOpen]);

  const requestJump = useJump(s => s.request);
  const jumpTo = (m: SearchMessageHit) => {
    ui.setSearchOpen(false);
    ui.selectChannel(m.group_id, m.channel_id);
    if (m.thread_id != null) {
      ui.openThread(m.thread_id, "replace");
      requestJump({ mid: m.id, container: "thread" });
    } else {
      requestJump({ mid: m.id, container: "log" });
    }
  };

  const runAsk = () => {
    if (!debouncedQ) return;
    setView("ask");
    setAnswer("loading");
    setSel(0);
    askAi.mutate({ q: debouncedQ, scope }, {
      onSuccess: (data) => setAnswer(data),
      onError: (e) => {
        toast("Ask AI failed: " + (e as Error).message, { variant: "warn" });
        setView("results");
        setAnswer(null);
      },
    });
  };

  const msgs = useMemo(
    () => appendUnique(resData?.messages?.items || [], extra),
    [resData, extra],
  );
  const commands = useMemo(() => view === "results" && tab === "all" && !scopeStr && !file && query.trim() === debouncedQ
    ? SHORTCUTS.filter(s => (s.id === "help.sheet" || s.id.startsWith("nav.") || ["settings", "ui.sidebar", "link.copy"].includes(s.id)) && shortcutAvailable(s, me) && (!s.desktopOnly || isDesktopShell()) &&
      (debouncedQ ? `${s.label} ${s.id}`.toLowerCase().includes(debouncedQ.toLowerCase()) :
        ["help.sheet", "nav.inbox", "nav.unreads", "nav.threads", "nav.approvals", "nav.drafts", "nav.schedules", "settings"].includes(s.id)))
    : [], [view, tab, scopeStr, file, query, debouncedQ, me?.voice_stt, me?.drafts_sync, me?.jarvis]);

  // Totals label the tabs and "See all"; they come from the overview so they
  // hold steady while a tab pages through its list.
  const totals: Record<SearchKind, number> = {
    groups: overview.data?.groups_total ?? overview.data?.groups?.length ?? 0,
    channels: overview.data?.channels_total ?? overview.data?.channels?.length ?? 0,
    threads: overview.data?.threads?.total ?? 0,
    messages: overview.data?.messages?.total ?? overview.data?.messages?.items.length ?? 0,
  };
  // Name matches don't apply to an attachment filter: only messages then.
  const tabs: Tab[] = file ? ["all", "messages"]
    : ["all", ...(totals.groups ? ["groups" as const] : []), "channels", "threads", "messages"];
  // A tab's first page plus any it loaded since; the overview shows first pages.
  const paged = <T extends { id: string | number },>(kind: SearchKind, first: T[] | undefined) =>
    appendUnique(first ?? [], tab === kind ? extraSide as unknown as T[] : []);
  const groupHits = paged<SearchGroupHit>("groups", resData?.groups);
  const channelHits = paged<SearchChannelHit>("channels", resData?.channels);
  const threadHits = paged<SearchThreadHit>("threads", resData?.threads?.items);
  // The first page's length plus every row fetched since: where the next
  // page starts, whatever was dropped as a repeat.
  const firstLen = tab === "messages" ? resData?.messages?.items.length ?? 0
    : tab === "groups" ? resData?.groups?.length ?? 0 : tab === "channels" ? resData?.channels?.length ?? 0
    : tab === "threads" ? resData?.threads?.items.length ?? 0 : 0;
  const cap = <T,>(rows: T[]) => tab === "all" ? rows.slice(0, OVERVIEW_ROWS) : rows;
  // An attachment filter is about messages; name matches don't apply (the
  // server skips them too), so their sections and See all links go.
  const names = !file;
  const shownGroups = names && (tab === "all" || tab === "groups") ? cap(groupHits) : [];
  const shownChannels = names && (tab === "all" || tab === "channels") ? cap(channelHits) : [];
  const shownThreads = names && (tab === "all" || tab === "threads") ? cap(threadHits) : [];
  const shownMsgs = tab === "all" || tab === "messages" ? cap(msgs) : [];
  const seeAll = (kind: SearchKind, shown: number) => tab === "all" && shown > 0 && (totals[kind] > shown
    || (kind === "messages" && !!overview.data?.messages?.has_more));
  // Paging within a tab follows that tab's own response, not the overview:
  // messages its has_more, the other kinds its total.
  const tabTotal = tab === "groups" ? resData?.groups_total : tab === "channels" ? resData?.channels_total
    : tab === "threads" ? resData?.threads?.total : undefined;
  // A first page shorter than asked for is the whole list, whatever the
  // total says; threads report has_more themselves.
  const firstHasMore = tab === "threads" ? !!resData?.threads?.has_more
    : firstLen >= SEARCH_PAGE && firstLen < (tabTotal ?? 0);
  // Channels and groups have an exact total: nothing past it, however the
  // last page looked.
  const hasMore = tab === "messages" ? (morePages ?? !!resData?.messages?.has_more)
    : tab !== "all" && (morePages ?? firstHasMore)
      && (tab === "threads" || firstLen + fetched < (tabTotal ?? 0));

  // Build the item list in display order.
  const items: Item[] = useMemo(() => {
    const list: Item[] = [];
    if (view === "ask") {
      if (answer && answer !== "loading" && answer.answer) {
        for (const m of answer.sources || []) list.push({ kind: "message", m });
      }
      return list;
    }
    if (!debouncedQ && !file) {
      for (const s of commands) list.push({ kind: "command", id: s.id });
      return list;
    }
    if (me?.search_ai && debouncedQ && tab === "all") list.push({ kind: "ask" });
    // "See all" sits in its section's heading, so it comes before the rows.
    if (seeAll("groups", shownGroups.length)) list.push({ kind: "seeall", tab: "groups" });
    for (const g of shownGroups) list.push({ kind: "group", g });
    if (seeAll("channels", shownChannels.length)) list.push({ kind: "seeall", tab: "channels" });
    for (const c of shownChannels) list.push({ kind: "channel", c });
    if (seeAll("threads", shownThreads.length)) list.push({ kind: "seeall", tab: "threads" });
    for (const t of shownThreads) list.push({ kind: "thread", t });
    for (const s of commands) list.push({ kind: "command", id: s.id });
    if (seeAll("messages", shownMsgs.length)) list.push({ kind: "seeall", tab: "messages" });
    for (const m of shownMsgs) list.push({ kind: "message", m });
    if (hasMore) list.push({ kind: "more" });
    return list;
  }, [view, answer, me, debouncedQ, resData, overview.data, msgs, extraSide, commands, scopeStr, file, tab, morePages, fetched]);

  // A tab whose kind no longer has hits (Groups after a retyped query, or
  // a name kind under a file filter) leaves the row; fall back to All.
  const tabGone = tab !== "all" && !!overview.data && !tabs.includes(tab);
  useEffect(() => { if (tabGone) { setTab("all"); resetPages(); } }, [tabGone]);

  /** Tabs, sort and See all hand focus back to the query, so typing and
      Enter (open the highlighted result) carry on from there. */
  const refocus = () => inputRef.current?.focus({ preventScroll: true });
  const openTab = (next: Tab) => {
    refocus();
    if (next === tab) return;
    setTab(next);
    resetPages();
  };

  const activate = (i: number) => {
    const it = items[i];
    if (!it) return;
    setSel(i);
    if (it.kind === "command") {
      ui.setSearchOpen(false);
      setTimeout(() => (window as Window & { __agoraShortcut?: (id: string) => void }).__agoraShortcut?.(it.id), 0);
      return;
    }
    if (it.kind === "ask") { runAsk(); return; }
    if (it.kind === "seeall") { openTab(it.tab); return; }
    if (it.kind === "more") {
      if (pageInFlight.current || tab === "all") return;
      pageInFlight.current = true;
      const gen = pageGen.current;
      const offset = firstLen + fetchedRef.current;
      const landed = (rows: number) => { fetchedRef.current += rows; setFetched(fetchedRef.current); };
      const settled = () => { if (gen === pageGen.current) pageInFlight.current = false; };
      if (tab === "messages") {
        more.mutate({ q: debouncedQ, offset, scope, file, sort, limit: SEARCH_PAGE }, {
          onSettled: settled,
          onSuccess: (page) => {
            if (gen !== pageGen.current) return;
            const rows = page?.items || [];
            const fresh = appendUnique(msgs, rows).length - msgs.length;
            setExtra(x => [...x, ...rows]);
            landed(rows.length);
            setMorePages(moreAfterPage({ rows: rows.length, fresh, limit: SEARCH_PAGE, hasMore: !!page?.has_more }));
          },
          onError: (e) => toast("Couldn't load more results: " + (e as Error).message, { variant: "warn" }),
        });
      } else {
        const kind = tab;
        moreSide.mutate({ q: debouncedQ, offset, kind, scope }, {
          onSettled: settled,
          onSuccess: (page) => {
            if (gen !== pageGen.current) return;
            const rows = kind === "threads" ? page.threads?.items ?? [] : page[kind] ?? [];
            const listed: { id: string | number }[] = kind === "groups" ? groupHits : kind === "channels" ? channelHits : threadHits;
            const fresh = appendUnique(listed, rows).length - listed.length;
            setExtraSide(x => [...x, ...rows]);
            landed(rows.length);
            setMorePages(moreAfterPage({ rows: rows.length, fresh, limit: SEARCH_PAGE, hasMore: kind === "threads" ? page.threads?.has_more : undefined }));
          },
          onError: (e) => toast("Couldn't load more results: " + (e as Error).message, { variant: "warn" }),
        });
      }
      return;
    }
    if (it.kind === "thread") {
      ui.setSearchOpen(false);
      ui.selectChannel(it.t.group_id, it.t.channel_id);
      ui.openThread(it.t.id, "replace");
      return;
    }
    if (it.kind === "group") {
      ui.setSearchOpen(false);
      ui.openGroupPage(it.g.id);
      return;
    }
    if (it.kind === "channel") {
      ui.setSearchOpen(false);
      ui.selectChannel(it.c.group_id, it.c.id);
      return;
    }
    jumpTo(it.m);
  };

  // The shortcut hook owns Mod+K; this listener handles search-result keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (!useUiState.getState().searchOpen || !isTopDialog(panelRef.current)) return;
      if (e.isComposing) return;
      // An open filter list owns its keys; a focused button (tab, sort,
      // See all, close) keeps Enter but still lets the arrows move results.
      const target = e.target as HTMLElement | null;
      if (target?.closest?.(".ago-pick, .ago-pick-trigger[aria-expanded='true']")) return;
      if (e.key === "Enter" && target?.closest?.("button")) return;
      if (e.key === "ArrowDown") { e.preventDefault(); setSel(s => items.length ? (s + 1) % items.length : 0); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSel(s => items.length ? (s - 1 + items.length) % items.length : 0); return; }
      if (e.key === "Enter") { e.preventDefault(); activate(sel); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  if (!ui.searchOpen) return null;

  const scopeOptions: PickerOption[] = [
    { value: "", label: "Everywhere", icon: "globe" },
    ...groups.flatMap(g => [
      { value: `g:${g.id}`, label: g.name, heading: true, icon: "layout-grid", ariaLabel: `All of ${g.name}`, hint: "All" },
      ...(g.channels || []).map(c => ({ value: `c:${c.id}`, label: c.name, icon: g.id === DM_GROUP_ID ? "bot" : "#", group: `g:${g.id}` })),
    ]),
  ];

  const scopeName = (() => {
    for (const g of groups) {
      if (scopeStr === `g:${g.id}`) return g.name;
      for (const c of g.channels || []) if (scopeStr === `c:${c.id}`) return `#${c.name}`;
    }
    return "";
  })();

  let itemIdx = -1;
  const nextIdx = () => ++itemIdx;
  const sectionHead = (kind: SearchKind, shown: number) => {
    if (!shown) return null;
    const label = TAB_LABELS[kind];
    const total = totals[kind];
    const more = seeAll(kind, shown);
    const i = more ? nextIdx() : -1;
    return <div className="ago-search-label ago-search-section">
      <span>{label}</span>
      {tab === "all" && total > 0 && <span className="ago-search-count">{countLabel(kind, total)}</span>}
      {more && <button type="button" tabIndex={-1} className={`ago-search-seeall${sel === i ? " sel" : ""}`}
        onClick={() => activate(i)}>See all<Icon name="chevron-right" /></button>}
    </div>;
  };
  const renderCommands = () => commands.length > 0 && <>
    <div className="ago-search-label">Commands</div>
    {commands.map(s => {
      const i = nextIdx();
      return <div key={s.id} className={`ago-search-row${sel === i ? " sel" : ""}`}
        role="button" tabIndex={-1} onClick={() => activate(i)}>
        <span className="ago-search-ico"><Icon name="keyboard" /></span>
        <span className="ago-search-name">{s.label}</span>
        {bindingFor(s.id, currentPlatform()) && <kbd>{formatCombo(bindingFor(s.id, currentPlatform()), currentPlatform())}</kbd>}
      </div>;
    })}
  </>;

  return (
    <div className="ago-search-overlay" id="ago-search-overlay"
      onClick={e => { if (e.target === e.currentTarget) ui.setSearchOpen(false); }}>
      <div className="ago-search-panel" ref={panelRef} role="dialog" aria-modal="true" aria-label="Search conversations" tabIndex={-1}>
        <div className="ago-search-bar">
          <Icon name="search" />
          <input id="ago-search-input" ref={inputRef} placeholder="Search messages, channels, groups…"
            autoComplete="off" autoCapitalize="off" spellCheck={false}
            value={query} onChange={e => setQuery(e.target.value)} />
          <div className="ago-search-filters">
            <SearchPicker id="ago-search-scope" title="Search scope" value={scopeStr} options={scopeOptions}
              filterPlaceholder="Find a group or channel…" align="end"
              onChange={v => { setScopeStr(v); resetPages(); }} returnFocus={refocus} />
            <SearchPicker id="ago-search-files" title="Filter by attachment" value={file} options={FILE_OPTIONS} align="end"
              onChange={v => { setFile(v as FileFilter); if (v && tab !== "messages") setTab("all"); resetPages(); }}
              returnFocus={refocus} />
          </div>
          <button className="ago-x" title="Close (Esc)" onClick={() => ui.setSearchOpen(false)}>
            <Icon name="x" />
          </button>
        </div>
        {view === "results" && (debouncedQ || file) && (
          <div className="ago-search-tabbar">
            <div className="ago-search-tabs" role="tablist" aria-label="Result kinds">
              {tabs.map(t => (
                <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""}
                  onClick={() => openTab(t)}>
                  {TAB_LABELS[t]}
                  {t !== "all" && totals[t] > 0 && <span className="ago-search-count">{countLabel(t, totals[t])}</span>}
                </button>
              ))}
            </div>
            {(tab === "all" || tab === "messages") && debouncedQ && (
              <div className="ago-search-sort" role="group" aria-label="Sort messages">
                {([["", "Relevance"], ["new", "Newest"]] as const).map(([value, label]) => {
                  const current = tab === "all" ? overviewSort : sort;
                  return <button key={label} type="button" aria-pressed={current === value} className={current === value ? "on" : ""}
                    title={value ? "Newest messages first" : "Best matches first"}
                    onClick={() => {
                      refocus();
                      if (current === value) return;
                      // On All this sets the preference for Messages too.
                      if (tab === "all") setOverviewSort(value);
                      setSort(value);
                      resetPages();
                    }}>{label}</button>;
                })}
              </div>
            )}
          </div>
        )}
        <div className="ago-search-body" id="ago-search-body"
          onClick={e => {
            const cite = (e.target as HTMLElement).closest?.("[data-cite]");
            if (cite && answer && answer !== "loading") {
              e.preventDefault();
              const src = (answer.sources || [])[Number(cite.getAttribute("data-cite")) - 1];
              if (src) jumpTo(src);
            }
          }}>
          {view === "ask" ? (
            <>
              <div className="ago-search-askhead">
                <button className="btn sm" title="Back to results (Esc)"
                  onClick={() => { setView("results"); setAnswer(null); setSel(0); }}>
                  <Icon name="chevron-left" /> Results
                </button>
                <span className="ago-search-askq"><Icon name="sparkles" /> {debouncedQ}</span>
              </div>
              {!answer || answer === "loading" ? (
                <div className="ago-search-thinking"><Icon name="loader" cls="spin" /> Thinking…</div>
              ) : !answer.answer ? (
                <div className="ago-search-hint">{answer.detail || "No answer."}</div>
              ) : (
                <>
                  <div className="ago-search-answer"
                    dangerouslySetInnerHTML={{ __html: answerHTML(answer.answer, (answer.sources || []).length) }} />
                  {(answer.sources || []).length > 0 && <div className="ago-search-label">Sources</div>}
                  {(answer.sources || []).map((m, k) => {
                    const i = nextIdx();
                    return <MsgRow key={m.id} m={m} num={k + 1} sel={sel === i} onClick={() => activate(i)} />;
                  })}
                </>
              )}
            </>
          ) : !debouncedQ && !file ? (<>
            {renderCommands()}
            <div className="ago-search-hint">
              Search messages, channels, and groups{me?.search_ai ? " — or ask the AI a question" : ""}.
            </div>
          </>
          ) : (
            <>
              {me?.search_ai && debouncedQ && tab === "all" && (() => {
                const i = nextIdx();
                return (
                  <div key="ask" className={`ago-search-row ask${sel === i ? " sel" : ""}`}
                    title="Answer this from your message history" onClick={() => activate(i)}>
                    <span className="ago-search-spark"><Icon name="sparkles" /></span>
                    <span className="ago-search-ask-label">Ask Agora AI: <b>“{debouncedQ}”</b></span>
                  </div>
                );
              })()}
              {sectionHead("groups", shownGroups.length)}
              {shownGroups.map(g => {
                const i = nextIdx();
                return (
                  <div key={g.id} className={`ago-search-row${sel === i ? " sel" : ""}`}
                    title={`Open ${g.name}`} onClick={() => activate(i)}>
                    <span className="ago-search-ico"><Icon name="layout-grid" /></span>
                    <span className="ago-search-name">{g.name}</span>
                    {g.description ? <span className="ago-search-sub">{g.description}</span> : null}
                  </div>
                );
              })}
              {sectionHead("channels", shownChannels.length)}
              {shownChannels.map(c => {
                const i = nextIdx();
                return (
                  <div key={c.id} className={`ago-search-row${sel === i ? " sel" : ""}`}
                    title={`Open #${c.name}`} onClick={() => activate(i)}>
                    <span className="ago-search-ico hash">#</span>
                    <span className="ago-search-name">{c.name}</span>
                    <span className="ago-search-crumb">{c.group_name || ""}</span>
                    {c.topic ? <span className="ago-search-sub">{c.topic}</span> : null}
                  </div>
                );
              })}
              {sectionHead("threads", shownThreads.length)}
              {shownThreads.map(t => {
                const i = nextIdx();
                return <ThreadRow key={t.id} t={t} sel={sel === i} onClick={() => activate(i)} />;
              })}
              {renderCommands()}
              {sectionHead("messages", shownMsgs.length)}
              {shownMsgs.map(m => {
                const i = nextIdx();
                return <MsgRow key={m.id} m={m} num={0} sel={sel === i} onClick={() => activate(i)} />;
              })}
              {hasMore && (() => {
                const i = nextIdx();
                const pending = more.isPending || moreSide.isPending;
                return (
                  <div key="more" className={`ago-search-row more${sel === i ? " sel" : ""}`} aria-disabled={pending || undefined}
                    onClick={() => activate(i)}>
                    {pending ? <><Icon name="loader" cls="spin" /> Loading…</> : "More results"}
                  </div>
                );
              })()}
              {res.isError ? (
                <div className="ago-search-hint">Search failed: {(res.error as Error).message}</div>
              ) : (res.isLoading || tabPending) && (debouncedQ || file) ? (
                <div className="ago-search-hint">Searching…</div>
              ) : resData && !commands.length && !shownGroups.length && !shownChannels.length && !shownThreads.length && !shownMsgs.length ? (
                <div className="ago-search-hint">
                  {debouncedQ
                    ? `No ${tab === "all" ? "results" : TAB_LABELS[tab].toLowerCase()} for “${debouncedQ}”${scopeName ? ` in ${scopeName}` : ""}`
                    : `No messages with ${FILE_LABELS[file] || "attachments"} found${scopeName ? ` in ${scopeName}` : ""}`}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
