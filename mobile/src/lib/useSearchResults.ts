/* Search screen state, ported from the web SearchPane: an overview that
   caps each kind at OVERVIEW_ROWS with "See all" into one kind's full list,
   per-tab "More results" paging, and a best-match/newest toggle for
   messages. Data and paging only; the screen owns input, Ask AI and
   navigation.

   Like the web, the tab and both sorts survive a retyped query, scope or
   file change (the screen mounting fresh is the "open" that resets them);
   those changes drop the loaded pages, a file filter moves a name-kind tab
   back to All, and a tab whose kind loses its hits falls back to All. */

import { useRef, useState } from "react";
import {
  appendUnique, moreAfterPage, OVERVIEW_ROWS, SEARCH_PAGE, useSearch, useSearchKindMore, useSearchMore,
  type FileFilter, type SearchChannelHit, type SearchGroupHit, type SearchKind, type SearchMessageHit,
  type SearchResponse, type SearchScope, type SearchSort, type SearchThreadHit,
} from "@agora/core";

/** "all" is the overview; the rest list one kind in full. */
export type SearchTab = "all" | SearchKind;

export const SEARCH_KINDS: readonly SearchKind[] = ["groups", "channels", "threads", "messages"];

/** Tab counts. They come from the overview so they hold steady while a tab
    pages through its list. */
export function searchTotals(overview: SearchResponse | undefined): Record<SearchKind, number> {
  return {
    groups: overview?.groups_total ?? overview?.groups?.length ?? 0,
    channels: overview?.channels_total ?? overview?.channels?.length ?? 0,
    threads: overview?.threads?.total ?? 0,
    messages: overview?.messages?.total ?? overview?.messages?.items.length ?? 0,
  };
}

/** Name matches don't apply to an attachment filter: only messages then.
    Groups shows only when it has hits; the other kinds always do. */
export function searchTabs(totals: Record<SearchKind, number>, file: FileFilter): SearchTab[] {
  return file ? ["all", "messages"]
    : ["all", ...(totals.groups ? ["groups" as const] : []), "channels", "threads", "messages"];
}

/** "See all" per overview section: only on All, only for a section showing
    rows, and only when there are more than it shows. Message totals stop
    at the server's cap, so `has_more` also counts. */
export function searchSeeAll(
  tab: SearchTab, totals: Record<SearchKind, number>, shown: Record<SearchKind, number>, messagesHasMore: boolean,
): Record<SearchKind, boolean> {
  const one = (kind: SearchKind) => tab === "all" && shown[kind] > 0
    && (totals[kind] > shown[kind] || (kind === "messages" && messagesHasMore));
  return { groups: one("groups"), channels: one("channels"), threads: one("threads"), messages: one("messages") };
}

/** Rows in the open tab's first page: with the rows fetched since, where
    the next page starts, whatever was dropped as a repeat. */
export function searchFirstLen(tab: SearchTab, data: SearchResponse | undefined): number {
  switch (tab) {
    case "messages": return data?.messages?.items.length ?? 0;
    case "groups": return data?.groups?.length ?? 0;
    case "channels": return data?.channels?.length ?? 0;
    case "threads": return data?.threads?.items.length ?? 0;
    default: return 0;
  }
}

/** Whether the open tab offers "More results". Paging follows the tab's own
    response, not the overview: messages its has_more, threads theirs, and
    channels/groups their exact total. `morePages` is the latest extra
    page's verdict (null until one loaded); `fetched` counts its rows. */
export function searchHasMore(
  tab: SearchTab, data: SearchResponse | undefined, morePages: boolean | null, fetched: number,
): boolean {
  if (tab === "all") return false;
  if (tab === "messages") return morePages ?? !!data?.messages?.has_more;
  const firstLen = searchFirstLen(tab, data);
  const total = (tab === "groups" ? data?.groups_total : tab === "channels" ? data?.channels_total
    : data?.threads?.total) ?? 0;
  // A first page shorter than asked for is the whole list, whatever the
  // total says; threads report has_more themselves.
  const firstHasMore = tab === "threads" ? !!data?.threads?.has_more
    : firstLen >= SEARCH_PAGE && firstLen < total;
  // Channels and groups have an exact total: nothing past it, however the
  // last page looked.
  return (morePages ?? firstHasMore) && (tab === "threads" || firstLen + fetched < total);
}

type SideHit = SearchGroupHit | SearchChannelHit | SearchThreadHit;

/** Pages loaded past the first by "More results", for one generation. */
interface Pages {
  gen: number;
  messages: SearchMessageHit[];
  side: SideHit[];
  /** The latest page's verdict; null until one loaded. */
  more: boolean | null;
  /** Rows those pages returned, repeats included: the next offset. */
  fetched: number;
}

const scopeKey = (s?: SearchScope) => s?.channelId ? `c:${s.channelId}` : s?.groupId ? `g:${s.groupId}` : "";

/** `q` arrives debounced and trimmed. */
export function useSearchResults(q: string, scope: SearchScope | undefined, file: FileFilter) {
  const [tab, setTabState] = useState<SearchTab>("all");
  // The Messages tab's order, and the overview's. The overview's changes
  // only when the toggle is used on All, so switching tabs never changes its
  // query (and never refetches it).
  const [msgSort, setMsgSort] = useState<SearchSort>("");
  const [overviewSort, setOverviewSort] = useState<SearchSort>("");
  // Bumped by refetch: a refreshed first page drops pages loaded after the
  // old one, whose offsets no longer line up.
  const [refreshes, setRefreshes] = useState(0);

  // An attachment filter moves a name-kind tab back to All (adjusted during
  // render, so no frame asks for a kind the filter excludes).
  const [lastFile, setLastFile] = useState(file);
  if (lastFile !== file) {
    setLastFile(file);
    if (file && tab !== "messages") setTabState("all");
  }

  const overviewOpts = { overview: true, sort: overviewSort, limit: OVERVIEW_ROWS + 1 } as const;
  // On All the second call passes the overview's own arguments, so both
  // share one cached query rather than searching twice.
  const overview = useSearch(q, scope, file, overviewOpts);
  const tabRes = useSearch(q, scope, file,
    tab === "all" ? overviewOpts : { kind: tab, sort: tab === "messages" ? msgSort : "" });
  // A tab just opened shows the previous query's (or kind's) rows as
  // placeholder data; treat that as still loading rather than as its list.
  const tabPending = tab !== "all" && tabRes.isPlaceholderData;
  const res = tab === "all" ? overview : tabRes;
  const data = tabPending ? undefined : res.data;

  const totals = searchTotals(overview.data);
  const tabs = searchTabs(totals, file);
  // A tab whose kind no longer has hits (Groups after a retyped query)
  // leaves the row; fall back to All.
  if (tab !== "all" && overview.data && !tabs.includes(tab)) setTabState("all");

  // Loaded pages belong to one query, scope, filter, tab and sort: each
  // change starts a new generation, and a page that lands for an older one
  // is dropped rather than appended to the wrong list. Derived in render,
  // so the first frame after a change already shows no stale pages.
  const pageKey = [q, scopeKey(scope), file, tab, tab === "messages" ? msgSort : "", refreshes].join("\u0001");
  const genRef = useRef({ key: pageKey, n: 0 });
  if (genRef.current.key !== pageKey) genRef.current = { key: pageKey, n: genRef.current.n + 1 };
  const gen = genRef.current.n;
  const [pagesState, setPages] = useState<Pages>({ gen, messages: [], side: [], more: null, fetched: 0 });
  const pages: Pages = pagesState.gen === gen ? pagesState : { gen, messages: [], side: [], more: null, fetched: 0 };
  // The ref is current the moment a page lands (the state only a render
  // later), and one page request runs at a time, so a quick second "More"
  // can neither reuse an offset nor skip rows.
  const fetchedRef = useRef({ gen, n: 0 });
  const inFlight = useRef<number | null>(null);

  const more = useSearchMore();
  const moreSide = useSearchKindMore();

  // A tab's first page plus any it loaded since; the overview shows first pages.
  const paged = <T extends { id: string | number }>(kind: SearchKind, first: T[] | undefined) =>
    appendUnique(first ?? [], tab === kind ? pages.side as unknown as T[] : []);
  const groupHits = paged<SearchGroupHit>("groups", data?.groups);
  const channelHits = paged<SearchChannelHit>("channels", data?.channels);
  const threadHits = paged<SearchThreadHit>("threads", data?.threads?.items);
  const msgHits = appendUnique(data?.messages?.items ?? [], pages.messages);
  const cap = <T,>(rows: T[]) => tab === "all" ? rows.slice(0, OVERVIEW_ROWS) : rows;
  // The server skips name matches under a file filter; so do the sections.
  const names = !file;
  const groups = names && (tab === "all" || tab === "groups") ? cap(groupHits) : [];
  const channels = names && (tab === "all" || tab === "channels") ? cap(channelHits) : [];
  const threads = names && (tab === "all" || tab === "threads") ? cap(threadHits) : [];
  const messages = tab === "all" || tab === "messages" ? cap(msgHits) : [];

  const seeAll = searchSeeAll(tab, totals,
    { groups: groups.length, channels: channels.length, threads: threads.length, messages: messages.length },
    !!overview.data?.messages?.has_more);
  const hasMore = searchHasMore(tab, data, pages.more, pages.fetched);
  const firstLen = searchFirstLen(tab, data);

  const setTab = (next: SearchTab) => setTabState(next);

  /** The order of the visible list: the overview's on All, the Messages
      tab's there; other kinds are always most recently active first. */
  const sort: SearchSort = tab === "all" ? overviewSort : tab === "messages" ? msgSort : "";
  const setSort = (value: SearchSort) => {
    // On All this sets the preference for Messages too.
    if (tab === "all") setOverviewSort(value);
    setMsgSort(value);
  };

  const loadMore = (opts?: { onError?: (e: Error) => void }) => {
    if (tab === "all" || !hasMore || inFlight.current === gen) return;
    inFlight.current = gen;
    if (fetchedRef.current.gen !== gen) fetchedRef.current = { gen, n: 0 };
    const offset = firstLen + fetchedRef.current.n;
    const settled = () => { if (inFlight.current === gen) inFlight.current = null; };
    const land = (rows: number, update: (p: Pages) => Pages, verdict: boolean) => {
      fetchedRef.current.n += rows;
      const n = fetchedRef.current.n;
      setPages(p => ({ ...update(p.gen === gen ? p : { gen, messages: [], side: [], more: null, fetched: 0 }), more: verdict, fetched: n }));
    };
    const onError = (e: unknown) => opts?.onError?.(e as Error);
    if (tab === "messages") {
      more.mutate({ q, offset, scope, file, sort: msgSort, limit: SEARCH_PAGE }, {
        onSettled: settled,
        onError,
        onSuccess: (page) => {
          if (gen !== genRef.current.n) return;
          const rows = page?.items ?? [];
          const fresh = appendUnique(msgHits, rows).length - msgHits.length;
          land(rows.length, p => ({ ...p, messages: [...p.messages, ...rows] }),
            moreAfterPage({ rows: rows.length, fresh, limit: SEARCH_PAGE, hasMore: !!page?.has_more }));
        },
      });
      return;
    }
    const kind = tab;
    moreSide.mutate({ q, offset, kind, scope }, {
      onSettled: settled,
      onError,
      onSuccess: (page) => {
        if (gen !== genRef.current.n) return;
        const rows: SideHit[] = kind === "threads" ? page.threads?.items ?? [] : page[kind] ?? [];
        const listed: { id: string | number }[] = kind === "groups" ? groupHits : kind === "channels" ? channelHits : threadHits;
        const fresh = appendUnique(listed, rows).length - listed.length;
        land(rows.length, p => ({ ...p, side: [...p.side, ...rows] }),
          moreAfterPage({ rows: rows.length, fresh, limit: SEARCH_PAGE, hasMore: kind === "threads" ? page.threads?.has_more : undefined }));
      },
    });
  };

  const refetch = () => {
    setRefreshes(n => n + 1);
    void overview.refetch();
    if (tab !== "all") void tabRes.refetch();
  };

  const active = q.length > 0 || !!file;
  return {
    tab, setTab,
    sort, setSort,
    /** The sort toggle applies (All or Messages, with a typed query). */
    canSort: (tab === "all" || tab === "messages") && q.length > 0,
    tabs, totals,
    groups, channels, threads, messages,
    seeAll,
    hasMore, loadMore,
    loadingMore: more.isPending || moreSide.isPending,
    /** Whether a search runs at all (a query, or a file filter alone). */
    active,
    /** The open tab's results have arrived (placeholder data excluded). */
    ready: !!data,
    isLoading: active && (res.isLoading || tabPending),
    isError: res.isError,
    error: res.error,
    refetch,
    isRefetching: res.isRefetching && !tabPending,
  };
}

export type SearchResults = ReturnType<typeof useSearchResults>;
