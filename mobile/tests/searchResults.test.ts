import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ApiClient, ApiProvider, appendUnique, SEARCH_PAGE,
  type FileFilter, type SearchKind, type SearchMessageHit, type SearchResponse, type SearchScope,
} from "@agora/core";
import {
  searchHasMore, searchSeeAll, searchTabs, searchTotals, useSearchResults, type SearchResults,
} from "../src/lib/useSearchResults";

const totals = (t: Partial<Record<SearchKind, number>>): Record<SearchKind, number> =>
  ({ groups: 0, channels: 0, threads: 0, messages: 0, ...t });
const none = totals({});
const msg = (id: number) => ({ id }) as SearchMessageHit;
const channel = (id: string) => ({ id, group_id: "g", name: id, topic: "", hidden: false, group_name: "G" });
const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

describe("searchTotals", () => {
  it("prefers the server totals and falls back to the rows returned", () => {
    expect(searchTotals(undefined)).toEqual(none);
    expect(searchTotals({ query: "q", channels: [channel("a")], channels_total: 9, groups: [],
      threads: { items: [], has_more: false, offset: 0, total: 3 },
      messages: { items: [msg(1), msg(2)], has_more: false, offset: 0 } }))
      .toEqual({ groups: 0, channels: 9, threads: 3, messages: 2 });
  });
});

describe("searchTabs", () => {
  it("shows Groups only when it has hits", () => {
    expect(searchTabs(none, "")).toEqual(["all", "channels", "threads", "messages"]);
    expect(searchTabs(totals({ groups: 2 }), "")).toEqual(["all", "groups", "channels", "threads", "messages"]);
  });
  it("keeps only All and Messages under a file filter", () => {
    expect(searchTabs(totals({ groups: 2, channels: 5 }), "image")).toEqual(["all", "messages"]);
  });
});

describe("searchSeeAll", () => {
  const shown = totals({ groups: 2, channels: 4, threads: 4, messages: 4 });
  it("offers See all only when the total passes what the overview shows", () => {
    expect(searchSeeAll("all", totals({ groups: 2, channels: 4, threads: 5, messages: 9 }), shown, false))
      .toEqual({ groups: false, channels: false, threads: true, messages: true });
  });
  it("counts has_more for messages, whose total is capped", () => {
    expect(searchSeeAll("all", totals({ messages: 4 }), shown, true).messages).toBe(true);
    expect(searchSeeAll("all", totals({ channels: 4 }), shown, true).channels).toBe(false);
  });
  it("never offers it off the overview or for an empty section", () => {
    expect(searchSeeAll("messages", totals({ messages: 99 }), shown, true).messages).toBe(false);
    expect(searchSeeAll("all", totals({ groups: 3 }), totals({}), false).groups).toBe(false);
  });
});

describe("searchHasMore", () => {
  const chans = (n: number, total: number): SearchResponse =>
    ({ query: "q", channels: range(0, n).map(i => channel(`c${i}`)), channels_total: total });
  it("follows has_more for messages, then the latest page", () => {
    const data: SearchResponse = { query: "q", messages: { items: [msg(1)], has_more: true, offset: 0 } };
    expect(searchHasMore("messages", data, null, 0)).toBe(true);
    expect(searchHasMore("messages", data, false, 50)).toBe(false);
    expect(searchHasMore("all", data, null, 0)).toBe(false);
  });
  it("stops channels at their exact total and at a short first page", () => {
    expect(searchHasMore("channels", chans(SEARCH_PAGE, 120), null, 0)).toBe(true);
    expect(searchHasMore("channels", chans(SEARCH_PAGE, 120), true, 70)).toBe(false);
    expect(searchHasMore("channels", chans(SEARCH_PAGE, SEARCH_PAGE), null, 0)).toBe(false);
    expect(searchHasMore("channels", chans(10, 120), null, 0)).toBe(false);
  });
  it("trusts the threads' own has_more over a total", () => {
    const threads = (has_more: boolean): SearchResponse =>
      ({ query: "q", threads: { items: [], has_more, offset: 0, total: 0 } });
    expect(searchHasMore("threads", threads(true), null, 0)).toBe(true);
    expect(searchHasMore("threads", threads(false), null, 0)).toBe(false);
    expect(searchHasMore("threads", threads(true), false, 50)).toBe(false);
  });
});

describe("appendUnique", () => {
  it("drops repeats from a later page", () => {
    expect(appendUnique([msg(1), msg(2)], [msg(2), msg(3), msg(3)]).map(m => m.id)).toEqual([1, 2, 3]);
  });
});

/* The hook against a fake server: the overview holds 6 messages (shown 4),
   the Messages tab pages 50 at a time out of 120. */
class SearchApi extends ApiClient {
  readonly gets: string[] = [];
  constructor() { super({ baseUrl: "https://example.invalid", token: "test" }); }
  override async get<T>(path: string) {
    this.gets.push(path);
    const p = new URLSearchParams(path.split("?")[1]);
    const offset = Number(p.get("offset") ?? 0);
    const page = (ids: number[], hasMore: boolean) => ({ items: ids.map(msg), has_more: hasMore, offset });
    if (p.get("totals") === "1" && p.get("types")?.includes(",")) {
      return { query: p.get("q"), messages: { ...page(range(1, 6), true), total: 120 },
        channels: [channel("a")], channels_total: 1, groups: [], groups_total: 0,
        threads: { items: [], has_more: false, offset: 0, total: 0 } } as T;
    }
    // Page two repeats the first page's last row, as a live list can.
    const ids = offset === 0 ? range(1, 50) : range(offset, 50);
    return { query: p.get("q"), messages: page(ids, offset + 50 < 120) } as T;
  }
}

let tree: TestRenderer.ReactTestRenderer | undefined;
let out: SearchResults;
const clients: QueryClient[] = [];
afterEach(() => { act(() => tree?.unmount()); tree = undefined; clients.splice(0).forEach(qc => qc.clear()); });
async function flush() { for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise(r => setTimeout(r, 5)); }); }
function Probe({ q, scope, file }: { q: string; scope?: SearchScope; file: FileFilter }) {
  out = useSearchResults(q, scope, file);
  return null;
}
function mount(api: ApiClient) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } });
  clients.push(qc);
  const el = (props: { q: string; file: FileFilter }) => React.createElement(QueryClientProvider, { client: qc },
    React.createElement(ApiProvider, { client: api }, React.createElement(Probe, props)));
  return { el };
}

test("caps the overview, pages the Messages tab, and resets pages on a new query", async () => {
  const api = new SearchApi();
  const { el } = mount(api);
  await act(async () => { tree = TestRenderer.create(el({ q: "deploy", file: "" })); });
  await flush();
  expect(out.tab).toBe("all");
  expect(out.messages.map(m => m.id)).toEqual([1, 2, 3, 4]);
  expect(out.seeAll.messages).toBe(true);
  expect(out.totals.messages).toBe(120);
  expect(out.hasMore).toBe(false);

  await act(async () => { out.setTab("messages"); });
  await flush();
  expect(out.messages).toHaveLength(50);
  expect(out.hasMore).toBe(true);
  await act(async () => { out.loadMore(); out.loadMore(); });
  await flush();
  // One request despite two taps, at the first page's end; the repeat drops.
  expect(api.gets.filter(g => g.includes("offset="))).toHaveLength(1);
  expect(api.gets.find(g => g.includes("offset="))).toContain("offset=50");
  expect(out.messages).toHaveLength(99);
  expect(new Set(out.messages.map(m => m.id)).size).toBe(99);

  await act(async () => { tree!.update(el({ q: "deploy now", file: "" })); });
  await flush();
  expect(out.tab).toBe("messages");
  expect(out.messages).toHaveLength(50);
}, 20_000);

test("a file filter moves a name-kind tab back to All", async () => {
  const { el } = mount(new SearchApi());
  await act(async () => { tree = TestRenderer.create(el({ q: "deploy", file: "" })); });
  await flush();
  await act(async () => { out.setTab("channels"); });
  expect(out.tab).toBe("channels");
  await act(async () => { tree!.update(el({ q: "deploy", file: "image" })); });
  expect(out.tab).toBe("all");
  expect(out.tabs).toEqual(["all", "messages"]);
  await flush();
  expect(out.channels).toEqual([]);
});
