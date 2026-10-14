import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import {
  QueryClient, QueryClientProvider, type FetchStatus, type InfiniteData,
} from "@tanstack/react-query";
import { ApiClient, ApiProvider, keys, useMessages, type Message } from "@agora/core";
import {
  SECTION_JUMP_PASSES_MS,
  SECTION_JUMP_SETTLE_MS,
  useSectionJump,
} from "../src/components/SectionRail";
import { trackBottom, useReadAck } from "../src/lib/readAck";
import {
  DIVIDER_VIEW_POSITION,
  LANDING_HIGHLIGHT_MS,
  MAX_LANDING_PAGES,
  landingStep,
  newestLoadedId,
  parseMessageId,
  mergeNewestPage,
  NEWEST_PAGE_TIMEOUT_MS,
  threadRootLoading,
  useMergeNewestPage,
  useMessageLanding,
} from "../src/lib/useMessageLanding";
import { useDividerSnapshot } from "../src/lib/useDividerSnapshot";


const message = (id: number): Message => ({
  id,
  channel_id: "general",
  thread_id: null,
  author_type: "user",
  author_id: "alice",
  author_name: "Alice",
  text: `Message ${id}`,
  ts: id,
  attachments: [],
});

/** Rows for ids lo..hi, with an optional "New" divider after `dividerAfter`. */
function rowsFor(lo: number, hi: number, dividerAfter?: number) {
  const out: unknown[] = [];
  for (let id = lo; id <= hi; id += 1) {
    out.push({ kind: "msg", m: message(id) });
    if (id === dividerAfter) out.push({ kind: "divider" });
  }
  return out;
}

describe("landingStep", () => {
  const base = {
    found: false, target: 20, oldestId: 101, newestId: 150, pagesFetched: 0,
    hasNextPage: true, fetching: false, failed: false,
  };

  it("lands once the row exists", () => {
    expect(landingStep({ ...base, found: true, pagesFetched: MAX_LANDING_PAGES })).toBe("land");
  });

  it("fetches older pages while the target is older than the loaded history", () => {
    expect(landingStep(base)).toBe("fetch");
    expect(landingStep({ ...base, fetching: true })).toBe("wait");
  });

  it("waits on a retry in flight even while the last fetch's error is still set", () => {
    expect(landingStep({ ...base, failed: true, fetching: true })).toBe("wait");
  });

  it("gives up on a missing id, the page cap, a failed fetch, or the start of history", () => {
    // In the loaded range but missing: the newest page is checked once (it
    // fills a hole the cache picked up), then it's gone.
    expect(landingStep({ ...base, oldestId: 10 })).toBe("refetch");
    expect(landingStep({ ...base, oldestId: 10, refreshed: true })).toBe("giveUp");
    // Offline the older page won't come: stop rather than hold the screen.
    expect(landingStep({ ...base, paused: true })).toBe("giveUp");
    expect(landingStep({ ...base, paused: true, fetching: true })).toBe("wait");
    expect(landingStep({ ...base, pagesFetched: MAX_LANDING_PAGES })).toBe("giveUp");
    expect(landingStep({ ...base, failed: true })).toBe("giveUp");
    expect(landingStep({ ...base, hasNextPage: false })).toBe("giveUp");
  });

  it("refetches once for a target newer than the loaded history instead of calling it gone", () => {
    const newer = { ...base, target: 160, oldestId: 101 };
    expect(landingStep(newer)).toBe("refetch");
    expect(landingStep({ ...newer, newestId: null, oldestId: null })).toBe("refetch");
    expect(landingStep({ ...newer, refreshing: true })).toBe("wait");
    expect(landingStep({ ...newer, refreshed: true })).toBe("giveUp");
  });

  it("waits for an older page in flight before merging the newest one", () => {
    // The page's result is built from the pages as they were when it
    // started: a merge written meanwhile would be overwritten.
    expect(landingStep({ ...base, target: 160, oldestId: 101, fetching: true })).toBe("wait");
  });

  it("waits while the newest page refetches, and only then", () => {
    const gone = { ...base, target: 120 };
    expect(landingStep(gone)).toBe("refetch");
    expect(landingStep({ ...gone, refreshing: true })).toBe("wait");
    expect(landingStep({ ...gone, refreshed: true })).toBe("giveUp");
  });

  it("never pages for a target that loads on its own", () => {
    const root = { ...base, target: 5, separate: true };
    expect(landingStep({ ...root, refreshing: true })).toBe("wait");
    expect(landingStep(root)).toBe("giveUp");
    expect(landingStep({ ...root, found: true })).toBe("land");
  });
});


describe("newestLoadedId", () => {
  it("is the highest loaded id, not the last row's: a bumped message sorts last", () => {
    expect(newestLoadedId([])).toBeNull();
    expect(newestLoadedId([{ id: 101 }, { id: 150 }, { id: 30 }])).toBe(150);
  });
});

describe("threadRootLoading", () => {
  it("is loading while the root's fetch or the top-level history that may hold it is", () => {
    const idle = { isPending: false, isFetching: false };
    expect(threadRootLoading({ isFetching: true }, idle)).toBe(true);
    expect(threadRootLoading({ isFetching: false }, { isPending: true, isFetching: true })).toBe(true);
    expect(threadRootLoading({ isFetching: false }, idle)).toBe(false);
    // A top-level refetch of loaded history, or one paused offline, isn't.
    expect(threadRootLoading({ isFetching: false }, { isPending: false, isFetching: true })).toBe(false);
    expect(threadRootLoading({ isFetching: false }, { isPending: true, isFetching: false })).toBe(false);
  });
});

describe("parseMessageId", () => {
  it("takes only positive integers as a landing target", () => {
    expect(parseMessageId("42")).toBe(42);
    for (const bad of [undefined, "", "abc", "12abc", "0", "-3", "1.5", " 7", "1e3", "99999999999999999999"]) {
      expect(parseMessageId(bad)).toBeNull();
    }
    expect(parseMessageId(["1", "2"])).toBeNull();
  });
});

describe("useMessageLanding", () => {
  type Props = {
    target: number | null;
    nonce?: string | null;
    rows: unknown[];
    pageCount: number;
    hasNextPage?: boolean;
    isFetchingNextPage?: boolean;
    failed?: boolean;
    refreshing?: boolean;
    paused?: boolean;
    separateTarget?: boolean;
    separateTargetLoading?: boolean;
    loaded?: boolean;
    dividerReady?: boolean;
    dividerMessageId?: number | null;
    latestId?: number;
    lastReadId?: number;
    onOpeningDecided?: () => void;
    /** Wire the divider like the channel screen: from useDividerSnapshot
        over `channel`/`groups` (dividerReady/onOpeningDecided unused). */
    snapshot?: boolean;
    channel?: { unread?: number; last_read_id?: number };
    groups?: { isPending: boolean; fetchStatus: FetchStatus; failureCount?: number };
  };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function mount(initial: Props) {
    const list = { scrollToIndex: jest.fn(), scrollToEnd: jest.fn() };
    const listRef = { current: list };
    const fetchNextPage = jest.fn();
    // Each refetch stays in flight until the test settles (or fails) it.
    const refetches: { resolve: () => void; reject: (e: Error) => void }[] = [];
    const refetch = jest.fn(() =>
      new Promise<void>((resolve, reject) => { refetches.push({ resolve, reject }); }));
    const ack = jest.fn();
    const atBottom = { current: false };
    const rereadPosition = jest.fn(() => false);
    let landing!: ReturnType<typeof useMessageLanding>;
    let marker = 0;
    let dividerReady = false;
    let onReachedBottom!: () => void;
    let props = initial;
    function Harness(p: Props) {
      const msgs = p.rows.filter((r) => (r as { kind: string }).kind === "msg") as { m: Message }[];
      const oldest = msgs[0];
      const latestId = p.latestId ?? 150;
      const { jumpToSection, cancelSectionJump } = useSectionJump({ listRef, rows: p.rows, atBottom, latestId });
      const divider = useDividerSnapshot(
        p.channel, { failureCount: 0, ...(p.groups ?? { isPending: true, fetchStatus: "fetching" }) },
      );
      marker = divider.marker;
      dividerReady = divider.dividerReady;
      landing = useMessageLanding({
        target: p.target,
        nonce: p.nonce,
        rows: p.rows,
        oldestId: oldest?.m.id ?? null,
        newestId: newestLoadedId(msgs.map((r) => r.m)),
        separateTarget: p.separateTarget,
        separateTargetLoading: p.separateTargetLoading,
        history: {
          loaded: p.loaded ?? true,
          pageCount: p.pageCount,
          hasNextPage: p.hasNextPage ?? true,
          isFetchingNextPage: p.isFetchingNextPage ?? false,
          failed: p.failed ?? false,
          refreshing: p.refreshing,
          paused: p.paused,
          fetchNextPage,
          refetch,
        },
        dividerReady: p.snapshot ? divider.dividerReady : p.dividerReady,
        dividerMessageId: p.dividerMessageId,
        onOpeningDecided: p.snapshot ? divider.onOpeningDecided : p.onOpeningDecided,
        atBottom,
        jumpTo: jumpToSection,
        cancelJump: cancelSectionJump,
        scrollToEnd: () => list.scrollToEnd({ animated: false }),
        rereadPosition,
      });
      onReachedBottom = useReadAck(latestId, () => p.lastReadId ?? 100, ack, atBottom, landing.decided);
      return null;
    }
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(React.createElement(Harness, initial));
    });
    const h = {
      list, fetchNextPage, refetch, ack, atBottom, rereadPosition,
      get landing() { return landing; },
      /** The divider snapshot's marker and readiness (snapshot mode). */
      get marker() { return marker; },
      get dividerReady() { return dividerReady; },
      update(next: Partial<Props>) {
        props = { ...props, ...next };
        act(() => tree.update(React.createElement(Harness, props)));
      },
      /** The oldest refetch in flight settles, with `next` as the new props. */
      async settleRefetch(next: Partial<Props> = {}, failed = false) {
        props = { ...props, refreshing: false, ...next };
        await act(async () => {
          const r = refetches.shift()!;
          if (failed) r.reject(new Error("offline")); else r.resolve();
          tree.update(React.createElement(Harness, props));
        });
      },
      listLoaded: () => act(() => landing.onListLoad()),
      /** One onScroll at (or away from) the bottom, as trackBottom sees it. */
      scroll(atEnd: boolean) {
        act(() => {
          trackBottom({
            contentOffset: { y: atEnd ? 1500 : 100 },
            layoutMeasurement: { height: 500 },
            contentSize: { height: 2000 },
          }, atBottom, onReachedBottom);
        });
      },
      unmount: () => act(() => tree.unmount()),
    };
    return h;
  }


  it("waits for the first page and the list's first layout before paging", () => {
    const h = mount({ target: 20, rows: [], pageCount: 0, loaded: false });
    h.listLoaded();
    expect(h.fetchNextPage).not.toHaveBeenCalled();
    h.update({ loaded: true, rows: rowsFor(101, 150), pageCount: 1 });
    expect(h.fetchNextPage).toHaveBeenCalledTimes(1);
    expect(h.atBottom.current).toBe(false);
    h.unmount();
  });

  it("pages until the target exists, then lands it centered and highlighted", () => {
    const h = mount({ target: 20, rows: rowsFor(101, 150), pageCount: 1 });
    h.listLoaded();
    expect(h.fetchNextPage).toHaveBeenCalledTimes(1);
    // Re-renders mid-fetch must not double-fetch the same page.
    h.update({ isFetchingNextPage: true });
    h.update({ rows: rowsFor(101, 151), isFetchingNextPage: true });
    expect(h.fetchNextPage).toHaveBeenCalledTimes(1);
    h.update({ rows: rowsFor(51, 150), pageCount: 2, isFetchingNextPage: false });
    expect(h.fetchNextPage).toHaveBeenCalledTimes(2);
    h.update({ rows: rowsFor(1, 150), pageCount: 3 });
    expect(h.fetchNextPage).toHaveBeenCalledTimes(2);
    expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 19, animated: false, viewPosition: 0.5 });
    expect(h.landing.highlightedId).toBe(20);
    // Decided once the jump has settled, not when it starts.
    expect(h.landing.decided).toBe(false);
    act(() => jest.advanceTimersByTime(SECTION_JUMP_SETTLE_MS));
    expect(h.landing.decided).toBe(true);
    act(() => jest.advanceTimersByTime(LANDING_HIGHLIGHT_MS));
    expect(h.landing.highlightedId).toBeNull();
    h.unmount();
  });

  it("asks again for a page whose fetch was cancelled instead of waiting forever", () => {
    const h = mount({ target: 20, rows: rowsFor(101, 150), pageCount: 1 });
    h.listLoaded();
    h.update({ isFetchingNextPage: true });
    // A refetch/invalidation cancelled it: no page, no error, nothing in flight.
    h.update({ isFetchingNextPage: false });
    expect(h.fetchNextPage).toHaveBeenCalledTimes(2);
    expect(h.landing.decided).toBe(false);
    h.update({ rows: rowsFor(1, 150), pageCount: 2 });
    expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 19, animated: false, viewPosition: 0.5 });
    h.unmount();
  });

  it("re-resolves the target's index by id when older rows prepend after landing", () => {
    const h = mount({ target: 120, rows: rowsFor(101, 150), pageCount: 1 });
    h.listLoaded();
    expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 19, animated: false, viewPosition: 0.5 });
    // Scroll-paging prepends a page while the correction passes are pending.
    h.update({ rows: rowsFor(51, 150), pageCount: 2 });
    act(() => jest.advanceTimersByTime(SECTION_JUMP_PASSES_MS[0]));
    expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 69, animated: false, viewPosition: 0.5 });
    act(() => jest.advanceTimersByTime(SECTION_JUMP_PASSES_MS[1]));
    expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 69, animated: false, viewPosition: 0.5 });
    h.unmount();
  });

  it("caps paging relative to where the landing started, even with many cached pages", () => {
    let pages = 12;
    const h = mount({ target: 5, rows: rowsFor(1000, 1050), pageCount: pages });
    h.listLoaded();
    for (let i = 0; i < MAX_LANDING_PAGES + 3; i += 1) {
      if (h.fetchNextPage.mock.calls.length > i) {
        pages += 1;
        h.update({ pageCount: pages, rows: rowsFor(1000 - (pages - 12) * 50, 1050) });
      }
    }
    expect(h.fetchNextPage).toHaveBeenCalledTimes(MAX_LANDING_PAGES);
    // Out of budget: settle on the newest message instead.
    expect(h.list.scrollToEnd).toHaveBeenCalledWith({ animated: false });
    expect(h.atBottom.current).toBe(true);
    expect(h.landing.decided).toBe(true);
    h.unmount();
  });

  it("a drag cancels both further paging and the correction passes", () => {
    const h = mount({ target: 20, rows: rowsFor(101, 150), pageCount: 1 });
    h.listLoaded();
    expect(h.fetchNextPage).toHaveBeenCalledTimes(1);
    act(() => h.landing.cancelLanding());
    h.update({ rows: rowsFor(51, 150), pageCount: 2 });
    h.update({ rows: rowsFor(1, 150), pageCount: 3 });
    expect(h.fetchNextPage).toHaveBeenCalledTimes(1);
    expect(h.list.scrollToIndex).not.toHaveBeenCalled();
    h.unmount();

    const landed = mount({ target: 120, rows: rowsFor(101, 150), pageCount: 1 });
    landed.listLoaded();
    expect(landed.list.scrollToIndex).toHaveBeenCalledTimes(1);
    act(() => landed.landing.cancelLanding());
    act(() => jest.advanceTimersByTime(2000));
    expect(landed.list.scrollToIndex).toHaveBeenCalledTimes(1);
    landed.unmount();
  });

  describe("a queued message bumped to the newest position", () => {
    // Ordered by seq: an old id (30) sits after 150, as the server's
    // bump_message_seq leaves it when an agent picks a queued message up.
    const bumped = (lo: number) => [...rowsFor(lo, 150), { kind: "msg", m: message(30) }];

    it("pages for an older target instead of refetching for a newer one", () => {
      const h = mount({ target: 50, rows: bumped(101), pageCount: 1 });
      h.listLoaded();
      expect(h.refetch).not.toHaveBeenCalled();
      expect(h.fetchNextPage).toHaveBeenCalledTimes(1);
      h.update({ rows: bumped(51), pageCount: 2 });
      h.update({ rows: bumped(1), pageCount: 3 });
      expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 49, animated: false, viewPosition: 0.5 });
      expect(h.landing.highlightedId).toBe(50);
      h.unmount();
    });

    it("doesn't give up on an older target the next pages bring", () => {
      const h = mount({ target: 50, rows: bumped(101), pageCount: 1, dividerMessageId: 120 });
      h.listLoaded();
      expect(h.refetch).not.toHaveBeenCalled();
      expect(h.list.scrollToIndex).not.toHaveBeenCalled(); // not the divider fallback
      h.update({ rows: bumped(41), pageCount: 2 });
      expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 9, animated: false, viewPosition: 0.5 });
      expect(h.landing.highlightedId).toBe(50);
      h.unmount();
    });
  });

  describe("a takeover before the landing could start", () => {
    it("doesn't land that target once history arrives, but a new request still lands", () => {
      const h = mount({ target: 20, nonce: "a", rows: [], pageCount: 0, loaded: false });
      h.listLoaded();
      act(() => h.landing.cancelLanding()); // a drag while the first page loads
      h.update({ loaded: true, rows: rowsFor(1, 150), pageCount: 1 });
      expect(h.fetchNextPage).not.toHaveBeenCalled();
      expect(h.list.scrollToIndex).not.toHaveBeenCalled();
      expect(h.landing.decided).toBe(true);
      h.update({ nonce: "b" }); // the same notification tapped again
      expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 19, animated: false, viewPosition: 0.5 });
      h.update({ target: 40, nonce: null });
      expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 39, animated: false, viewPosition: 0.5 });
      h.unmount();
    });

    it("doesn't page for a target whose list wasn't laid out yet", () => {
      const h = mount({ target: 20, rows: rowsFor(101, 150), pageCount: 1 });
      act(() => h.landing.cancelLanding());
      h.listLoaded();
      expect(h.fetchNextPage).not.toHaveBeenCalled();
      expect(h.list.scrollToIndex).not.toHaveBeenCalled();
      h.unmount();
    });
  });

  it("doesn't keep waiting on a query refetch once its own merge has settled", async () => {
    const hole = rowsFor(101, 150).filter((r) => (r as { m?: Message }).m?.id !== 120);
    const h = mount({ target: 120, rows: hole, pageCount: 1 });
    h.listLoaded();
    expect(h.refetch).toHaveBeenCalledTimes(1);
    // Its merge times out while the query refetch it set off (gap path) is
    // still running: the landing gives up instead of waiting on that.
    await h.settleRefetch({ refreshing: true }, true);
    expect(h.list.scrollToEnd).toHaveBeenCalledWith({ animated: false });
    expect(h.landing.decided).toBe(true);
    expect(h.landing.isMerging()).toBe(false);
    h.unmount();
  });

  it("a second tap waits for the first tap's merge rather than racing it", async () => {
    const h = mount({ target: null, rows: rowsFor(101, 150), pageCount: 1 });
    h.listLoaded();
    h.update({ target: 160, nonce: "tap1" });
    expect(h.refetch).toHaveBeenCalledTimes(1);
    h.update({ target: 170, nonce: "tap2" });
    // The first request is still out: the new run neither starts a second
    // merge nor lets paging run under it.
    expect(h.refetch).toHaveBeenCalledTimes(1);
    expect(h.landing.isMerging()).toBe(true);
    await h.settleRefetch();
    expect(h.refetch).toHaveBeenCalledTimes(2);
    h.unmount();
  });

  it("reports its own merge as in flight, so paging holds off", () => {
    const h = mount({ target: 160, rows: rowsFor(101, 150), pageCount: 1 });
    h.listLoaded();
    expect(h.refetch).toHaveBeenCalledTimes(1);
    expect(h.landing.isMerging()).toBe(true);
    h.unmount();
  });

  it("opens an empty conversation at the bottom without waiting for a first layout", () => {
    // FlashList never lays out (so never calls onLoad) with no rows.
    const h = mount({ target: null, rows: [], pageCount: 1 });
    expect(h.landing.decided).toBe(true);
    expect(h.atBottom.current).toBe(true);
    h.unmount();
  });

  it("opens an empty conversation with a target without waiting for a first layout", () => {
    const h = mount({ target: 160, rows: [], pageCount: 1 });
    expect(h.landing.decided).toBe(true);
    expect(h.atBottom.current).toBe(true);
    // A first live message mounts the list: no landing starts for the old
    // target, so acks and pinning stay on.
    h.update({ rows: rowsFor(170, 170) });
    h.listLoaded();
    expect(h.landing.decided).toBe(true);
    expect(h.refetch).not.toHaveBeenCalled();
    expect(h.atBottom.current).toBe(true);
    h.unmount();
  });

  it("fills a hole in the cache: an in-range target the newest page brings lands", async () => {
    const hole = rowsFor(101, 150).filter((r) => (r as { m?: Message }).m?.id !== 120);
    const h = mount({ target: 120, rows: hole, pageCount: 1 });
    h.listLoaded();
    expect(h.refetch).toHaveBeenCalledTimes(1);
    await h.settleRefetch({ rows: rowsFor(101, 150) });
    expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 19, animated: false, viewPosition: 0.5 });
    expect(h.landing.highlightedId).toBe(120);
    h.unmount();
  });

  it("falls back to the divider when the target is gone", async () => {
    const h = mount({
      target: 104, rows: rowsFor(101, 150, 110).filter((r) => (r as { m?: Message }).m?.id !== 104),
      pageCount: 1, dividerMessageId: 111,
    });
    h.listLoaded();
    // Within the loaded history: one newest-page check, no paging, then gone.
    expect(h.fetchNextPage).not.toHaveBeenCalled();
    expect(h.refetch).toHaveBeenCalledTimes(1);
    await h.settleRefetch();
    expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 10, animated: false, viewPosition: 0.2 });
    expect(h.landing.highlightedId).toBeNull();
    h.unmount();
  });

  it("lands on the divider only once the read marker is known", () => {
    const h = mount({ target: null, rows: rowsFor(101, 150), pageCount: 1, dividerReady: false });
    h.listLoaded();
    expect(h.landing.decided).toBe(false);
    h.update({ rows: rowsFor(101, 150, 140), dividerReady: true, dividerMessageId: 141 });
    expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 41, animated: false, viewPosition: 0.2 });
    expect(h.atBottom.current).toBe(false);
    act(() => jest.advanceTimersByTime(SECTION_JUMP_SETTLE_MS));
    expect(h.landing.decided).toBe(true);
    h.unmount();
  });

  it("lands the first unread row, right under the divider row, at DIVIDER_VIEW_POSITION", () => {
    const rows = rowsFor(101, 150, 130);
    const h = mount({ target: null, rows, pageCount: 1, dividerMessageId: 131 });
    h.listLoaded();
    const [{ index, viewPosition }] = h.list.scrollToIndex.mock.calls[0] as [
      { index: number; viewPosition: number },
    ];
    expect((rows[index] as { m: Message }).m.id).toBe(131);
    expect((rows[index - 1] as { kind: string }).kind).toBe("divider");
    expect(viewPosition).toBe(DIVIDER_VIEW_POSITION);
    h.unmount();
  });

  it("a re-land that can't find its target after the opening decided stays put, without waiting for groups", async () => {
    // The groups payload's first fetch is still in flight, so the divider
    // isn't ready until the opening decides and freezes it.
    const h = mount({ target: 120, rows: rowsFor(101, 150), pageCount: 1, snapshot: true });
    h.listLoaded();
    act(() => jest.advanceTimersByTime(SECTION_JUMP_SETTLE_MS));
    expect(h.landing.decided).toBe(true);
    expect(h.dividerReady).toBe(true);
    // A refetch drops the target for good while the highlight still shows.
    const without120 = rowsFor(101, 150).filter((r) => (r as { m: Message }).m.id !== 120);
    h.update({ rows: without120 });
    // One newest-page check (it may be a hole), then it's gone for good.
    expect(h.refetch).toHaveBeenCalledTimes(1);
    await h.settleRefetch({ rows: without120 });
    expect(h.list.scrollToEnd).not.toHaveBeenCalled();
    expect(h.landing.decided).toBe(true);
    h.unmount();
  });

  it("reports the opening landing's decision once, when it has decided", () => {
    const onOpeningDecided = jest.fn();
    const h = mount({
      target: null, rows: rowsFor(101, 150), pageCount: 1, dividerReady: false, onOpeningDecided,
    });
    h.listLoaded();
    act(() => jest.advanceTimersByTime(10000));
    expect(onOpeningDecided).not.toHaveBeenCalled();
    // The read marker settles with nothing unread.
    h.update({ dividerReady: true });
    expect(onOpeningDecided).toHaveBeenCalledTimes(1);
    // Later landings in place aren't the opening one.
    h.update({ target: 120 });
    act(() => jest.advanceTimersByTime(SECTION_JUMP_SETTLE_MS));
    expect(h.landing.highlightedId).toBe(120);
    expect(onOpeningDecided).toHaveBeenCalledTimes(1);
    h.unmount();

    // A target that lands decides once its jump has settled (acks can start
    // then), not as it starts.
    const onTarget = jest.fn();
    const t = mount({
      target: 120, rows: rowsFor(101, 150), pageCount: 1, dividerReady: false, onOpeningDecided: onTarget,
    });
    t.listLoaded();
    expect(t.list.scrollToIndex).toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(SECTION_JUMP_SETTLE_MS - 1));
    expect(onTarget).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));
    expect(onTarget).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(LANDING_HIGHLIGHT_MS));
    expect(onTarget).toHaveBeenCalledTimes(1);
    t.unmount();
  });

  it("reports no opening decision when the user takes over first", () => {
    // A drag before the groups payload (see the divider snapshot tests for
    // what the screen does with it).
    const onOpeningDecided = jest.fn();
    const h = mount({
      target: null, rows: rowsFor(101, 150), pageCount: 1, dividerReady: false, onOpeningDecided,
    });
    h.listLoaded();
    act(() => h.landing.cancelLanding());
    expect(h.landing.decided).toBe(true);
    h.update({ rows: rowsFor(101, 150, 140), dividerReady: true, dividerMessageId: 141 });
    expect(onOpeningDecided).not.toHaveBeenCalled();
    // The user's position stands: the late marker lands nowhere.
    expect(h.list.scrollToIndex).not.toHaveBeenCalled();
    expect(h.list.scrollToEnd).not.toHaveBeenCalled();
    h.unmount();

    // The same for a rail/pill tap while an opening target is still paging.
    const onTarget = jest.fn();
    const t = mount({ target: 20, rows: rowsFor(101, 150), pageCount: 1, dividerReady: false, onOpeningDecided: onTarget });
    t.listLoaded();
    act(() => t.landing.cancelLanding());
    t.update({ rows: rowsFor(1, 150), pageCount: 2, dividerReady: true });
    act(() => jest.advanceTimersByTime(10000));
    expect(onTarget).not.toHaveBeenCalled();
    t.unmount();
  });


  it("opens at the newest message without scrolling when there's nothing to land on", () => {
    const h = mount({ target: null, rows: rowsFor(101, 150), pageCount: 1 });
    h.listLoaded();
    expect(h.list.scrollToIndex).not.toHaveBeenCalled();
    expect(h.list.scrollToEnd).not.toHaveBeenCalled();
    expect(h.atBottom.current).toBe(true);
    expect(h.landing.decided).toBe(true);
    h.unmount();
  });

  it("gives up when an older page fails to load", () => {
    const h = mount({ target: 20, rows: rowsFor(101, 150), pageCount: 1 });
    h.listLoaded();
    h.update({ failed: true });
    expect(h.atBottom.current).toBe(true);
    expect(h.landing.decided).toBe(true);
    h.unmount();
  });

  it("lands again when a refetch drops the target while the jump settles", () => {
    const h = mount({ target: 120, rows: rowsFor(101, 150), pageCount: 1 });
    h.listLoaded();
    expect(h.list.scrollToIndex).toHaveBeenCalledTimes(1);
    // Returning to the foreground refetched only the newest page.
    h.update({ rows: rowsFor(131, 180), pageCount: 1 });
    expect(h.fetchNextPage).toHaveBeenCalledTimes(1);
    h.update({ rows: rowsFor(81, 180), pageCount: 2 });
    expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 39, animated: false, viewPosition: 0.5 });
    h.unmount();
  });

  it("re-targets in place when the screen receives a new message id", () => {
    const h = mount({ target: null, rows: rowsFor(101, 150), pageCount: 1 });
    h.listLoaded();
    expect(h.atBottom.current).toBe(true);
    h.update({ target: 130 });
    expect(h.atBottom.current).toBe(false);
    expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 29, animated: false, viewPosition: 0.5 });
    expect(h.landing.highlightedId).toBe(130);
    h.unmount();
  });

  it("lands the same target again when its nonce changes, and only then", () => {
    const h = mount({ target: 130, nonce: "tap1", rows: rowsFor(101, 150), pageCount: 1 });
    h.listLoaded();
    act(() => jest.advanceTimersByTime(LANDING_HIGHLIGHT_MS));
    expect(h.landing.highlightedId).toBeNull();
    h.list.scrollToIndex.mockClear();
    h.update({ rows: rowsFor(101, 151) });
    expect(h.list.scrollToIndex).not.toHaveBeenCalled();
    // The reader scrolled away; a second tap for the same message.
    h.update({ nonce: "tap2" });
    expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 29, animated: false, viewPosition: 0.5 });
    expect(h.landing.highlightedId).toBe(130);
    expect(h.landing.decided).toBe(false);
    h.unmount();
  });

  it("re-reads the real scroll position once a landing settles or gives up", () => {
    const h = mount({ target: 150, rows: rowsFor(101, 150), pageCount: 1 });
    h.listLoaded();
    expect(h.rereadPosition).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(SECTION_JUMP_SETTLE_MS));
    expect(h.rereadPosition).toHaveBeenCalledTimes(1);
    // A target in place that can't be found re-reads too.
    h.update({ target: 30, hasNextPage: false });
    expect(h.rereadPosition).toHaveBeenCalledTimes(2);
    h.unmount();
  });

  it("leaves the viewport alone when an in-place landing can't find its target", () => {
    const h = mount({
      target: null, rows: rowsFor(101, 150, 140), pageCount: 1, dividerMessageId: 141,
    });
    h.listLoaded();
    act(() => jest.advanceTimersByTime(SECTION_JUMP_SETTLE_MS));
    expect(h.landing.decided).toBe(true);
    h.scroll(true); // the reader has since scrolled down to the newest message
    h.list.scrollToIndex.mockClear();
    // A notification for a message this conversation can't load.
    h.update({ target: 30, hasNextPage: false });
    expect(h.list.scrollToIndex).not.toHaveBeenCalled();
    expect(h.list.scrollToEnd).not.toHaveBeenCalled();
    expect(h.atBottom.current).toBe(true);
    expect(h.landing.decided).toBe(true);
    act(() => jest.advanceTimersByTime(2000));
    expect(h.list.scrollToIndex).not.toHaveBeenCalled();
    h.unmount();
  });

  describe("a target the cache doesn't have yet", () => {
    it("refetches once for a message newer than the stale cache and lands it when it arrives", async () => {
      const h = mount({ target: 160, rows: rowsFor(101, 150), pageCount: 1 });
      h.listLoaded();
      // Newer than anything loaded: not gone, and not something paging brings.
      expect(h.refetch).toHaveBeenCalledTimes(1);
      expect(h.fetchNextPage).not.toHaveBeenCalled();
      expect(h.list.scrollToEnd).not.toHaveBeenCalled();
      expect(h.landing.decided).toBe(false);
      // However long the request takes, it's waited for, and asked once.
      h.update({ refreshing: true });
      act(() => jest.advanceTimersByTime(30000));
      h.update({ rows: rowsFor(101, 151), refreshing: true });
      expect(h.landing.decided).toBe(false);
      expect(h.refetch).toHaveBeenCalledTimes(1);
      await h.settleRefetch({ rows: rowsFor(101, 165) });
      expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 59, animated: false, viewPosition: 0.5 });
      expect(h.landing.highlightedId).toBe(160);
      expect(h.refetch).toHaveBeenCalledTimes(1);
      h.unmount();
    });

    it("waits on its own refetch before the screen reports it as refreshing", async () => {
      const h = mount({ target: 160, rows: rowsFor(101, 150), pageCount: 1 });
      h.listLoaded();
      // A re-render in between (a socket message) mustn't read as settled.
      h.update({ rows: rowsFor(101, 151) });
      expect(h.list.scrollToEnd).not.toHaveBeenCalled();
      expect(h.landing.decided).toBe(false);
      await h.settleRefetch({ rows: rowsFor(101, 165) });
      expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 59, animated: false, viewPosition: 0.5 });
      h.unmount();
    });

    it("waits for the newest page's refetch in flight before calling a target gone", () => {
      const without120 = rowsFor(101, 150).filter((r) => (r as { m: Message }).m.id !== 120);
      const h = mount({ target: 120, rows: without120, pageCount: 1, refreshing: true });
      h.listLoaded();
      act(() => jest.advanceTimersByTime(30000));
      expect(h.landing.decided).toBe(false);
      h.update({ rows: rowsFor(101, 150), refreshing: false });
      expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 19, animated: false, viewPosition: 0.5 });
      expect(h.refetch).not.toHaveBeenCalled();
      h.unmount();
    });

    it("waits for a refetch already in flight rather than starting its own", () => {
      const h = mount({ target: 160, rows: rowsFor(101, 150), pageCount: 1, refreshing: true });
      h.listLoaded();
      expect(h.refetch).not.toHaveBeenCalled();
      expect(h.landing.decided).toBe(false);
      // It settles without the target: that was the fresh newest page.
      h.update({ refreshing: false });
      expect(h.refetch).not.toHaveBeenCalled();
      expect(h.list.scrollToEnd).toHaveBeenCalledWith({ animated: false });
      expect(h.landing.decided).toBe(true);
      h.unmount();
    });

    it("falls back to the divider when the refetch doesn't bring an opening target", async () => {
      const h = mount({ target: 160, rows: rowsFor(101, 150, 140), pageCount: 1, dividerMessageId: 141 });
      h.listLoaded();
      expect(h.list.scrollToIndex).not.toHaveBeenCalled();
      await h.settleRefetch();
      expect(h.refetch).toHaveBeenCalledTimes(1);
      expect(h.fetchNextPage).not.toHaveBeenCalled();
      expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 41, animated: false, viewPosition: 0.2 });
      expect(h.landing.highlightedId).toBeNull();
      h.unmount();
    });

    it("stops waiting on its own refetch once the query pauses (offline)", () => {
      const h = mount({ target: 160, rows: rowsFor(101, 150), pageCount: 1 });
      h.listLoaded();
      expect(h.refetch).toHaveBeenCalledTimes(1);
      expect(h.landing.decided).toBe(false);
      // The request never settles while offline: the landing falls back now.
      h.update({ paused: true });
      expect(h.list.scrollToEnd).toHaveBeenCalledWith({ animated: false });
      expect(h.atBottom.current).toBe(true);
      expect(h.landing.decided).toBe(true);
      expect(h.refetch).toHaveBeenCalledTimes(1);
      h.unmount();
    });

    it("doesn't refetch (or trim the cache) while the query is paused: it settles without", () => {
      const h = mount({ target: 160, rows: rowsFor(101, 150), pageCount: 1, paused: true });
      h.listLoaded();
      expect(h.refetch).not.toHaveBeenCalled();
      expect(h.list.scrollToEnd).toHaveBeenCalledWith({ animated: false });
      expect(h.landing.decided).toBe(true);
      h.unmount();
    });

    it("an in-place landing while paused leaves the viewport and the cache alone", () => {
      const h = mount({ target: null, rows: rowsFor(101, 150), pageCount: 3 });
      h.listLoaded();
      h.update({ target: 170, nonce: "tap1", paused: true });
      expect(h.refetch).not.toHaveBeenCalled();
      expect(h.list.scrollToIndex).not.toHaveBeenCalled();
      expect(h.atBottom.current).toBe(true);
      expect(h.landing.decided).toBe(true);
      h.unmount();
    });

    it("asks for the newest page once per landing, opening or in place", async () => {
      const h = mount({ target: 160, rows: rowsFor(101, 150), pageCount: 3 });
      h.listLoaded();
      expect(h.refetch).toHaveBeenCalledTimes(1);
      await h.settleRefetch();
      h.update({ target: 170, nonce: "tap1" });
      expect(h.refetch).toHaveBeenCalledTimes(2);
      await h.settleRefetch();
      expect(h.refetch).toHaveBeenCalledTimes(2);
      h.unmount();
    });

    it("settles and falls back when its request fails", async () => {
      const h = mount({ target: 160, rows: rowsFor(101, 150, 140), pageCount: 1, dividerMessageId: 141 });
      h.listLoaded();
      expect(h.landing.decided).toBe(false);
      await h.settleRefetch({}, true);
      expect(h.refetch).toHaveBeenCalledTimes(1);
      expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 41, animated: false, viewPosition: 0.2 });
      h.unmount();

      // In place: the viewport stays where the reader was.
      const p = mount({ target: null, rows: rowsFor(101, 150), pageCount: 1 });
      p.listLoaded();
      p.update({ target: 170, nonce: "tap1" });
      await p.settleRefetch({}, true);
      expect(p.list.scrollToIndex).not.toHaveBeenCalled();
      expect(p.atBottom.current).toBe(true);
      expect(p.landing.decided).toBe(true);
      p.unmount();
    });

    it("falls back to the newest message when there's no divider", async () => {
      const h = mount({ target: 160, rows: rowsFor(101, 150), pageCount: 1 });
      h.listLoaded();
      await h.settleRefetch();
      expect(h.list.scrollToEnd).toHaveBeenCalledWith({ animated: false });
      expect(h.atBottom.current).toBe(true);
      expect(h.landing.decided).toBe(true);
      h.unmount();
    });

    it("leaves the viewport alone when the refetch doesn't bring an in-place target", async () => {
      const h = mount({ target: null, rows: rowsFor(101, 150), pageCount: 1 });
      h.listLoaded();
      expect(h.atBottom.current).toBe(true);
      h.update({ target: 170, nonce: "tap1" });
      expect(h.atBottom.current).toBe(false);
      expect(h.refetch).toHaveBeenCalledTimes(1);
      await h.settleRefetch();
      expect(h.fetchNextPage).not.toHaveBeenCalled();
      expect(h.list.scrollToIndex).not.toHaveBeenCalled();
      expect(h.list.scrollToEnd).not.toHaveBeenCalled();
      // The list couldn't be re-read here, so the position from before stands.
      expect(h.atBottom.current).toBe(true);
      expect(h.landing.decided).toBe(true);
      // A late arrival no longer moves the reader.
      h.update({ rows: rowsFor(101, 170) });
      expect(h.list.scrollToIndex).not.toHaveBeenCalled();
      h.unmount();
    });

    it("re-lands a target that vanishes once a refetch in flight brings it back", async () => {
      const h = mount({ target: 160, rows: rowsFor(101, 150), pageCount: 1 });
      h.listLoaded();
      await h.settleRefetch({ rows: rowsFor(101, 165) });
      expect(h.list.scrollToIndex).toHaveBeenCalledTimes(1);
      // A foreground refetch drops it while the jump settles.
      h.update({ rows: rowsFor(101, 150), refreshing: true });
      act(() => jest.advanceTimersByTime(30000));
      expect(h.list.scrollToEnd).not.toHaveBeenCalled();
      expect(h.landing.decided).toBe(false);
      h.update({ rows: rowsFor(101, 165), refreshing: false });
      expect(h.list.scrollToIndex).toHaveBeenCalledTimes(2);
      expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 59, animated: false, viewPosition: 0.5 });
      expect(h.refetch).toHaveBeenCalledTimes(1);
      h.unmount();
    });

    it("leaves the viewer on a vanished (deleted) target, without refetching again", async () => {
      const h = mount({ target: 160, rows: rowsFor(101, 150), pageCount: 1 });
      h.listLoaded();
      await h.settleRefetch({ rows: rowsFor(101, 165) });
      expect(h.list.scrollToIndex).toHaveBeenCalledTimes(1);
      h.update({ rows: rowsFor(101, 150) });
      expect(h.refetch).toHaveBeenCalledTimes(1);
      // Already shown the target: no jump to the bottom (and no ack from one).
      expect(h.list.scrollToEnd).not.toHaveBeenCalled();
      expect(h.list.scrollToIndex).toHaveBeenCalledTimes(1);
      expect(h.landing.decided).toBe(true);
      h.unmount();
    });

    it("keeps its page budget when a reset shrinks the history mid-landing", () => {
      const h = mount({ target: 10, rows: rowsFor(1801, 2050), pageCount: 5, hasNextPage: true });
      h.listLoaded();
      expect(h.fetchNextPage).toHaveBeenCalledTimes(1);
      // Something resets the query to its newest page, then paging resumes.
      for (let pages = 1; pages <= MAX_LANDING_PAGES + 1; pages += 1) {
        h.update({ rows: rowsFor(2051 - pages * 50, 2050), pageCount: pages, hasNextPage: true });
      }
      // Counted from the reset: gives up after MAX_LANDING_PAGES pages since,
      // not after the 4 more a stale base would allow.
      expect(h.landing.decided).toBe(true);
      h.unmount();
    });

    it("leaves the viewport alone when a refetch settles after the user took over", async () => {
      const h = mount({ target: 160, rows: rowsFor(101, 150), pageCount: 1 });
      h.listLoaded();
      act(() => h.landing.cancelLanding());
      await h.settleRefetch({ rows: rowsFor(101, 165) });
      expect(h.list.scrollToEnd).not.toHaveBeenCalled();
      expect(h.list.scrollToIndex).not.toHaveBeenCalled();
      expect(h.landing.decided).toBe(true);
      h.unmount();
    });

    it("waits for a targeted thread root while its own fetch runs, instead of paging", () => {
      const h = mount({
        target: 5, rows: rowsFor(101, 150), pageCount: 1, separateTarget: true, separateTargetLoading: true,
      });
      h.listLoaded();
      act(() => jest.advanceTimersByTime(30000));
      expect(h.fetchNextPage).not.toHaveBeenCalled();
      expect(h.refetch).not.toHaveBeenCalled();
      expect(h.landing.decided).toBe(false);
      // The root's own fetch resolves: its row goes on top.
      h.update({ rows: [{ kind: "root", m: message(5) }, ...rowsFor(101, 150)], separateTargetLoading: false });
      expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 0, animated: false, viewPosition: 0.5 });
      expect(h.landing.highlightedId).toBe(5);
      expect(h.fetchNextPage).not.toHaveBeenCalled();
      h.unmount();
    });

    it("waits for a targeted root the top-level history may still bring", () => {
      // The top-level page that supplies the root is loading, so the root's
      // own fetch is disabled: nothing of its own is in flight.
      const loading = (topLevelPending: boolean) => threadRootLoading(
        { isFetching: false }, { isPending: topLevelPending, isFetching: topLevelPending },
      );
      const h = mount({
        target: 5, rows: rowsFor(101, 150), pageCount: 1, separateTarget: true,
        separateTargetLoading: loading(true),
      });
      h.listLoaded();
      expect(h.landing.decided).toBe(false);
      // It arrives with the top-level page, and the waiting ends with it.
      h.update({
        rows: [{ kind: "root", m: message(5) }, ...rowsFor(101, 150)], separateTargetLoading: loading(false),
      });
      expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 0, animated: false, viewPosition: 0.5 });
      expect(h.landing.highlightedId).toBe(5);
      h.unmount();
    });

    it("gives up on a thread root whose fetch brings nothing, without paging", () => {
      const h = mount({
        target: 5, rows: rowsFor(101, 150), pageCount: 1, separateTarget: true, separateTargetLoading: true,
      });
      h.listLoaded();
      expect(h.landing.decided).toBe(false);
      h.update({ separateTargetLoading: false });
      expect(h.fetchNextPage).not.toHaveBeenCalled();
      expect(h.refetch).not.toHaveBeenCalled();
      expect(h.landing.decided).toBe(true);
      h.unmount();
    });
  });


  it("an opening target that can't be found waits for the read marker before falling back", async () => {
    const without104 = (divider?: number) =>
      rowsFor(101, 150, divider).filter((r) => (r as { m?: Message }).m?.id !== 104);
    const h = mount({ target: 104, rows: without104(), pageCount: 1, dividerReady: false });
    h.listLoaded();
    await h.settleRefetch();
    h.scroll(true);
    act(() => jest.advanceTimersByTime(1000));
    // Not the newest message by default: that would skip the divider and
    // read the backlog.
    expect(h.list.scrollToEnd).not.toHaveBeenCalled();
    expect(h.landing.decided).toBe(false);
    expect(h.ack).not.toHaveBeenCalled();
    h.update({ rows: without104(110), dividerReady: true, dividerMessageId: 111 });
    expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 10, animated: false, viewPosition: 0.2 });
    act(() => jest.advanceTimersByTime(SECTION_JUMP_SETTLE_MS + 1000));
    expect(h.ack).not.toHaveBeenCalled();
    h.unmount();
  });

  it("a re-land stops the first jump, so its settling can't decide mid-paging", () => {
    const h = mount({ target: 120, rows: rowsFor(101, 150), pageCount: 1 });
    h.listLoaded();
    act(() => jest.advanceTimersByTime(SECTION_JUMP_PASSES_MS[0]));
    // A refetch drops the target before the first jump has settled.
    h.update({ rows: rowsFor(131, 180), pageCount: 1 });
    expect(h.fetchNextPage).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(SECTION_JUMP_SETTLE_MS));
    expect(h.landing.decided).toBe(false);
    expect(h.rereadPosition).not.toHaveBeenCalled();
    h.update({ rows: rowsFor(81, 180), pageCount: 2 });
    expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 39, animated: false, viewPosition: 0.5 });
    act(() => jest.advanceTimersByTime(SECTION_JUMP_SETTLE_MS));
    expect(h.landing.decided).toBe(true);
    expect(h.rereadPosition).toHaveBeenCalledTimes(1);
    h.unmount();
  });

  describe("the divider snapshot (useDividerSnapshot)", () => {
    const unread = { unread: 3, last_read_id: 140 };
    const loaded = { isPending: false, fetchStatus: "idle" as const };

    it("snapshots the read marker once the channel's metadata is there, and keeps it", () => {
      const h = mount({ target: null, rows: rowsFor(101, 150), pageCount: 1, snapshot: true });
      h.listLoaded();
      expect(h.marker).toBe(0);
      expect(h.landing.decided).toBe(false);
      h.update({ channel: unread, groups: loaded });
      expect(h.marker).toBe(140);
      h.update({ channel: { unread: 1, last_read_id: 149 } });
      expect(h.marker).toBe(140);
      h.unmount();

      const none = mount({
        target: null, rows: rowsFor(101, 150), pageCount: 1, snapshot: true,
        channel: { unread: 0, last_read_id: 140 }, groups: loaded,
      });
      none.listLoaded();
      expect(none.marker).toBe(0);
      expect(none.landing.decided).toBe(true);
      none.update({ channel: unread });
      expect(none.marker).toBe(0);
      none.unmount();
    });

    it("is ready unless the groups payload's first fetch is in flight", () => {
      const h = mount({ target: null, rows: [], pageCount: 0, loaded: false, snapshot: true });
      expect(h.dividerReady).toBe(false);
      // Offline (paused) or not fetching at all: nothing to wait for.
      h.update({ groups: { isPending: true, fetchStatus: "paused" } });
      expect(h.dividerReady).toBe(true);
      h.update({ groups: { isPending: true, fetchStatus: "idle" } });
      expect(h.dividerReady).toBe(true);
      h.update({ groups: { isPending: true, fetchStatus: "fetching" } });
      expect(h.dividerReady).toBe(false);
      // Loaded or failed (isPending false), even while refetching.
      h.update({ groups: { isPending: false, fetchStatus: "fetching" } });
      expect(h.dividerReady).toBe(true);
      h.unmount();
    });

    it("stops waiting once the first attempt failed, during the retry backoff", () => {
      const h = mount({ target: null, rows: rowsFor(101, 150), pageCount: 1, snapshot: true });
      h.listLoaded();
      expect(h.landing.decided).toBe(false);
      // TanStack keeps the query pending and fetching through its retries.
      h.update({ groups: { isPending: true, fetchStatus: "fetching", failureCount: 1 } });
      expect(h.dividerReady).toBe(true);
      expect(h.landing.decided).toBe(true);
      expect(h.marker).toBe(0);
      h.unmount();
    });

    it("opens without a divider when the groups payload fails or can't fetch", () => {
      const h = mount({ target: null, rows: rowsFor(101, 150), pageCount: 1, snapshot: true });
      h.listLoaded();
      expect(h.landing.decided).toBe(false);
      h.update({ groups: { isPending: true, fetchStatus: "paused" } });
      expect(h.landing.decided).toBe(true);
      expect(h.marker).toBe(0);
      h.unmount();
    });

    it("still shows the divider from groups arriving after a target's jump started", () => {
      const h = mount({ target: 120, rows: rowsFor(101, 150), pageCount: 1, snapshot: true });
      h.listLoaded();
      expect(h.list.scrollToIndex).toHaveBeenCalledTimes(1);
      act(() => jest.advanceTimersByTime(200));
      h.update({ channel: unread, groups: loaded });
      expect(h.marker).toBe(140);
      h.unmount();
    });

    it("freezes without a divider once the opening has decided", () => {
      // The target's jump settled: acks may have run from here.
      const h = mount({ target: 120, rows: rowsFor(101, 150), pageCount: 1, snapshot: true });
      h.listLoaded();
      act(() => jest.advanceTimersByTime(SECTION_JUMP_SETTLE_MS));
      expect(h.landing.decided).toBe(true);
      h.update({ channel: unread, groups: loaded });
      expect(h.marker).toBe(0);
      h.unmount();

      // No target, and the groups payload couldn't fetch (offline).
      const w = mount({
        target: null, rows: rowsFor(101, 150), pageCount: 1, snapshot: true,
        groups: { isPending: true, fetchStatus: "paused" },
      });
      w.listLoaded();
      expect(w.landing.decided).toBe(true);
      w.update({ channel: unread, groups: loaded });
      expect(w.marker).toBe(0);
      w.unmount();
    });

    it("still shows the divider from on-time groups after the user took over", () => {
      const h = mount({ target: null, rows: rowsFor(101, 150), pageCount: 1, snapshot: true });
      h.listLoaded();
      act(() => h.landing.cancelLanding());
      act(() => jest.advanceTimersByTime(10000));
      h.update({ channel: unread, groups: loaded });
      expect(h.marker).toBe(140);
      h.unmount();
    });
  });


  describe("read-ack gating", () => {
    it("acks nothing until a divider landing reaches the bottom, then exactly once", () => {
      const h = mount({ target: null, rows: rowsFor(101, 150), pageCount: 1, dividerReady: false });
      h.listLoaded();
      // FlashList's initial bottom render reports "at the bottom" before the
      // landing is decided: that must not read the backlog.
      h.scroll(true);
      act(() => jest.advanceTimersByTime(1000));
      expect(h.ack).not.toHaveBeenCalled();
      h.update({ rows: rowsFor(101, 150, 120), dividerReady: true, dividerMessageId: 121 });
      // With the JS thread busy, scroll events still report the old bottom
      // position while the jump is in flight: not a reach-the-bottom.
      h.scroll(true);
      act(() => jest.advanceTimersByTime(SECTION_JUMP_SETTLE_MS - 100));
      h.scroll(false);
      act(() => jest.advanceTimersByTime(100));
      act(() => jest.advanceTimersByTime(1000));
      expect(h.ack).not.toHaveBeenCalled();
      h.scroll(true);
      h.scroll(true);
      act(() => jest.advanceTimersByTime(1000));
      expect(h.ack).toHaveBeenCalledTimes(1);
      expect(h.ack).toHaveBeenCalledWith(150, expect.any(Function));
      h.unmount();
    });

    it("acks nothing while landing on a target until the viewer scrolls down", () => {
      const h = mount({ target: 20, rows: rowsFor(101, 150), pageCount: 1 });
      h.scroll(true);
      h.listLoaded();
      h.update({ rows: rowsFor(1, 150), pageCount: 2 });
      act(() => jest.advanceTimersByTime(2000));
      h.scroll(false);
      act(() => jest.advanceTimersByTime(1000));
      expect(h.ack).not.toHaveBeenCalled();
      h.scroll(true);
      act(() => jest.advanceTimersByTime(1000));
      expect(h.ack).toHaveBeenCalledTimes(1);
      h.unmount();
    });

    it("holds acks during an in-place landing until it settles", () => {
      const h = mount({ target: null, rows: rowsFor(101, 150), pageCount: 1, lastReadId: 150 });
      h.listLoaded();
      expect(h.landing.decided).toBe(true);
      // A newer message arrives while a notification re-lands the reader.
      h.update({ target: 120, rows: rowsFor(101, 151), latestId: 151 });
      expect(h.landing.decided).toBe(false);
      // Stale "at the bottom" reports from before the jump took effect.
      h.scroll(true);
      act(() => jest.advanceTimersByTime(SECTION_JUMP_SETTLE_MS - 100));
      h.scroll(false);
      act(() => jest.advanceTimersByTime(1000));
      expect(h.landing.decided).toBe(true);
      expect(h.ack).not.toHaveBeenCalled();
      h.scroll(true);
      act(() => jest.advanceTimersByTime(1000));
      expect(h.ack).toHaveBeenCalledWith(151, expect.any(Function));
      h.unmount();
    });

    it("acks the newest message once when the conversation opens at the bottom", () => {
      const h = mount({ target: null, rows: rowsFor(101, 150), pageCount: 1 });
      h.scroll(true);
      act(() => jest.advanceTimersByTime(1000));
      expect(h.ack).not.toHaveBeenCalled();
      h.listLoaded();
      act(() => jest.advanceTimersByTime(1000));
      expect(h.ack).toHaveBeenCalledTimes(1);
      h.unmount();
    });
  });
});

describe("mergeNewestPage", () => {
  const ids = (lo: number, hi: number) => {
    const out: Message[] = [];
    for (let id = lo; id <= hi; id += 1) out.push(message(id));
    return out;
  };

  /** useMessages for `threadId`, its pages served by before_id; `newest` is
      what a later newest-page request returns. */
  async function mountMessages(pages: Record<string, Message[]>, threadId: number | null = null) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const api = new ApiClient({ baseUrl: "https://agora.example", token: "test" });
    const served = { ...pages };
    const get = jest.spyOn(api, "get").mockImplementation(async (path: string) => {
      const before = new URLSearchParams(path.split("?")[1]).get("before_id") ?? "initial";
      return { messages: served[before] ?? [] } as never;
    });
    let result!: ReturnType<typeof useMessages>;
    let merge!: () => Promise<void>;
    function Harness() {
      // Spread: reads every field, so TanStack's tracked result re-renders on
      // all of them (the assertions read data/hasNextPage after the fact).
      result = { ...useMessages("general", threadId) };
      merge = useMergeNewestPage("general", threadId);
      return null;
    }
    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(
        QueryClientProvider, { client: qc },
        React.createElement(ApiProvider, { client: api }, React.createElement(Harness)),
      ));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return {
      qc, api, get, served,
      get result() { return result; },
      get merge() { return merge; },
      /** Runs `fn`, then lets TanStack's batched (next-tick) notify re-render. */
      async step(fn: () => Promise<unknown> | void) {
        await act(async () => {
          await fn();
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      },
      unmount: () => { act(() => tree.unmount()); qc.clear(); },
    };
  }
  const idsOf = (page: Message[] | undefined) => (page ?? []).map((m) => m.id);

  it("requests the newest page once and leaves the older cached pages alone", async () => {
    const h = await mountMessages({ initial: ids(101, 150), "101": ids(51, 100), "51": ids(1, 50) });
    await h.step(() => h.result.fetchNextPage());
    await h.step(() => h.result.fetchNextPage());
    const before = h.result.data!;
    expect(before.pages).toHaveLength(3);
    h.get.mockClear();
    h.served.initial = ids(111, 160);
    await h.step(() => h.merge());
    expect(h.get).toHaveBeenCalledTimes(1);
    expect(h.get.mock.calls[0][0]).toBe("/api/channels/general/messages?limit=50");
    const after = h.result.data!;
    expect(after.pages).toHaveLength(3);
    expect(after.pages[1]).toBe(before.pages[1]);
    expect(after.pages[2]).toBe(before.pages[2]);
    expect(after.pageParams).toEqual(before.pageParams);
    // New messages merged; those already cached aren't inserted twice.
    expect(idsOf(after.pages[0])).toEqual(ids(101, 160).map((m) => m.id));
    h.unmount();
  });

  it("gives up on a newest-page request that never answers, leaving the cache alone", async () => {
    jest.useFakeTimers();
    try {
      const qc = new QueryClient();
      const before = { pages: [ids(101, 150)], pageParams: [undefined] };
      qc.setQueryData(keys.messages("general", null), before);
      const api = { get: jest.fn(() => new Promise<never>(() => {})) };
      const done = mergeNewestPage(api as never, qc, "general", null);
      const outcome = jest.fn();
      done.then(() => outcome("resolved"), () => outcome("rejected"));
      await Promise.resolve();
      jest.advanceTimersByTime(NEWEST_PAGE_TIMEOUT_MS - 1);
      await Promise.resolve();
      expect(outcome).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      await done.catch(() => {});
      expect(outcome).toHaveBeenCalledWith("rejected");
      expect(qc.getQueryData(keys.messages("general", null))).toBe(before);
      qc.clear();
    } finally {
      jest.useRealTimers();
    }
  });

  it("ignores a newest page that answers after the deadline", async () => {
    jest.useFakeTimers();
    try {
      const qc = new QueryClient();
      const before = { pages: [ids(101, 150)], pageParams: [undefined] };
      qc.setQueryData(keys.messages("general", null), before);
      let answer!: (v: unknown) => void;
      const api = { get: jest.fn(() => new Promise((resolve) => { answer = resolve; })) };
      const done = mergeNewestPage(api as never, qc, "general", null);
      jest.advanceTimersByTime(NEWEST_PAGE_TIMEOUT_MS);
      await done.catch(() => {});
      answer({ messages: ids(101, 160) });
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      expect(qc.getQueryData(keys.messages("general", null))).toBe(before);
      qc.clear();
    } finally {
      jest.useRealTimers();
    }
  });

  it("bounds the gap path's rebuild by the same deadline", async () => {
    jest.useFakeTimers();
    try {
      const qc = new QueryClient();
      qc.setQueryData(keys.messages("general", null), { pages: [ids(101, 150)], pageParams: [undefined] });
      const refetchQueries = jest.spyOn(qc, "refetchQueries").mockImplementation(() => new Promise<never>(() => {}));
      const cancelQueries = jest.spyOn(qc, "cancelQueries").mockResolvedValue(undefined);
      const api = { get: jest.fn(async () => ({ messages: ids(200, 249) })) };
      const outcome = jest.fn();
      const done = mergeNewestPage(api as never, qc, "general", null);
      done.then(() => outcome("resolved"), () => outcome("rejected"));
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      expect(refetchQueries).toHaveBeenCalled();
      jest.advanceTimersByTime(NEWEST_PAGE_TIMEOUT_MS);
      await done.catch(() => {});
      expect(outcome).toHaveBeenCalledWith("rejected");
      // The rebuild still out is cancelled, so it can't swap pages later.
      expect(cancelQueries).toHaveBeenCalledWith({ queryKey: keys.messages("general", null), exact: true });
      qc.clear();
    } finally {
      jest.useRealTimers();
    }
  });

  it("rebuilds the history contiguously when a full newest page shares nothing with the cache", async () => {
    const h = await mountMessages({ initial: ids(101, 150), "101": ids(51, 100) });
    await h.step(() => h.result.fetchNextPage());
    h.get.mockClear();
    // More than a page arrived since: merging would hide 151..199.
    h.served.initial = ids(200, 249);
    h.served["200"] = ids(150, 199);
    await h.step(() => h.merge());
    const after = h.result.data!;
    // Both cached pages are kept (another screen may be showing them), and
    // rebuilt from the newest page down with nothing missing between.
    expect(after.pages).toHaveLength(2);
    expect(idsOf(after.pages[0])).toEqual(ids(200, 249).map((m) => m.id));
    expect(idsOf(after.pages[1])).toEqual(ids(150, 199).map((m) => m.id));
    h.unmount();
  });

  it("serves every mounted screen on the key: another observer keeps its paged history", async () => {
    const h = await mountMessages({ initial: ids(101, 150), "101": ids(51, 100) });
    await h.step(() => h.result.fetchNextPage());
    h.served.initial = ids(111, 155);
    await h.step(() => mergeNewestPage(h.api, h.qc, "general", null));
    expect(h.result.data?.pages).toHaveLength(2);
    expect(idsOf(h.result.data?.pages[1])[0]).toBe(51);
    expect(idsOf(h.result.data?.pages[0]).slice(-1)[0]).toBe(155);
    h.unmount();
  });

  it("uses the thread's replies key and thread_id", async () => {
    const reply = (id: number) => ({ ...message(id), thread_id: 7 });
    const h = await mountMessages({ initial: [reply(8), reply(9)] }, 7);
    h.get.mockClear();
    h.served.initial = [reply(8), reply(9), reply(10)];
    await h.step(() => h.merge());
    expect(h.get).toHaveBeenCalledTimes(1);
    expect(h.get.mock.calls[0][0]).toBe("/api/channels/general/messages?limit=50&thread_id=7");
    expect(idsOf(h.result.data?.pages[0])).toEqual([8, 9, 10]);
    expect(h.qc.getQueryData(keys.messages("general", null))).toBeUndefined();
    h.unmount();
  });

  it("keeps the short-page bookkeeping: a short newest page still ends history", async () => {
    const h = await mountMessages({ initial: ids(101, 130) });
    expect(h.result.hasNextPage).toBe(false);
    h.served.initial = ids(101, 160);
    await h.step(() => h.merge());
    expect(idsOf(h.result.data?.pages[0])).toHaveLength(60);
    expect(h.result.hasNextPage).toBe(false);
    h.unmount();
  });

  it("rejects and leaves the cache as it was when the request fails", async () => {
    const h = await mountMessages({ initial: ids(101, 150) });
    const before = h.result.data;
    h.get.mockRejectedValueOnce(new Error("offline"));
    await expect(h.merge()).rejects.toThrow("offline");
    expect(h.result.data).toBe(before);
    h.unmount();
  });
});
