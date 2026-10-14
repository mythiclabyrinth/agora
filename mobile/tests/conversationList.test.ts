import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { SECTION_JUMP_SETTLE_MS } from "../src/components/SectionRail";
import { listScrollMetrics, useConversationList } from "../src/lib/useConversationList";

const rowsFor = (lo: number, hi: number) => {
  const out: unknown[] = [];
  for (let id = lo; id <= hi; id += 1) out.push({ kind: "msg", m: { id } });
  return out;
};

describe("listScrollMetrics", () => {
  const list = (offset: number) => ({
    getAbsoluteLastScrollOffset: () => offset,
    getWindowSize: () => ({ height: 500 }),
    getFirstItemOffset: () => 40,
    getChildContainerDimensions: () => ({ height: 1960 }),
  });

  it("reports the position like an onScroll, the header included in the content", () => {
    expect(listScrollMetrics(list(700))).toEqual({
      contentOffset: { y: 700 },
      layoutMeasurement: { height: 500 },
      contentSize: { height: 2000 },
    });
  });

  it("clamps an unclamped scrollToIndex target to the real scroll range", () => {
    expect(listScrollMetrics(list(9999))?.contentOffset.y).toBe(1500);
    expect(listScrollMetrics(list(-20))?.contentOffset.y).toBe(0);
  });

  it("is null when the list can't say yet", () => {
    expect(listScrollMetrics(null)).toBeNull();
    expect(listScrollMetrics({ getAbsoluteLastScrollOffset: () => 0 })).toBeNull();
    expect(listScrollMetrics({
      ...list(0),
      getChildContainerDimensions: () => { throw new Error("no layout manager"); },
    })).toBeNull();
    expect(listScrollMetrics({ ...list(0), getWindowSize: () => ({ height: 0 }) })).toBeNull();
  });
});

describe("useConversationList", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  type Props = {
    rows?: unknown[];
    target?: number | null;
    pageCount?: number;
    hasNextPage?: boolean;
    refetch?: () => Promise<unknown>;
    failed?: boolean;
    paused?: boolean;
  };

  it("holds off older-page paging while the landing merges the newest page", () => {
    const rows = [{ kind: "msg", m: { id: 101 } }, { kind: "msg", m: { id: 150 } }];
    // A target newer than the cache: the landing's merge is left in flight.
    const h = mount({ rows, target: 160, hasNextPage: true, refetch: () => new Promise(() => {}) });
    h.listLoaded();
    act(() => h.hook.listProps.onStartReached());
    expect(h.fetchNextPage).not.toHaveBeenCalled();
    h.unmount();
  });

  it("loads the older page when a landing settles at the start of the loaded history", () => {
    // A thread root target: row 0, landed with no scroll FlashList would
    // turn into onStartReached.
    const rows = [{ kind: "msg", m: { id: 101 } }, { kind: "msg", m: { id: 150 } }];
    const h = mount({ rows, target: 101, hasNextPage: true }, 0);
    h.listLoaded();
    act(() => jest.advanceTimersByTime(5000));
    expect(h.fetchNextPage).toHaveBeenCalled();
    h.unmount();
  });

  it.each([["failed", { failed: true }], ["paused", { paused: true }]])(
    "doesn't retry the older page at the start when it %s",
    (_, extra) => {
      const rows = [{ kind: "msg", m: { id: 101 } }, { kind: "msg", m: { id: 150 } }];
      const h = mount({ rows, target: 101, hasNextPage: true, ...extra }, 0);
      h.listLoaded();
      act(() => jest.advanceTimersByTime(5000));
      expect(h.fetchNextPage).not.toHaveBeenCalled();
      h.unmount();
    },
  );

  it("keeps loading older pages while the viewer stays at the start as each one lands", () => {
    const rows = [{ kind: "msg", m: { id: 101 } }, { kind: "msg", m: { id: 150 } }];
    const h = mount({ rows, hasNextPage: true }, 0);
    h.listLoaded();
    act(() => jest.advanceTimersByTime(5000));
    h.fetchNextPage.mockClear();
    // A page lands below the anchored first row: no scroll, still at the start.
    act(() => h.hook.listProps.onContentSizeChange());
    expect(h.fetchNextPage).toHaveBeenCalledTimes(1);
    h.unmount();
  });

  it("doesn't load older pages on growth away from the start", () => {
    const rows = [{ kind: "msg", m: { id: 101 } }, { kind: "msg", m: { id: 150 } }];
    const h = mount({ rows, hasNextPage: true }, 1500);
    h.listLoaded();
    act(() => jest.advanceTimersByTime(5000));
    h.fetchNextPage.mockClear();
    act(() => h.hook.listProps.onContentSizeChange());
    expect(h.fetchNextPage).not.toHaveBeenCalled();
    h.unmount();
  });

  it("doesn't load older pages when a landing settles away from the start", () => {
    const rows = [{ kind: "msg", m: { id: 101 } }, { kind: "msg", m: { id: 150 } }];
    const h = mount({ rows, target: 150, hasNextPage: true }, 1500);
    h.listLoaded();
    act(() => jest.advanceTimersByTime(5000));
    expect(h.fetchNextPage).not.toHaveBeenCalled();
    h.unmount();
  });

  function mount(initial: Props = {}, offset = 0) {
    const list = {
      scrollToIndex: jest.fn(),
      scrollToEnd: jest.fn(),
      // FlashList's bookkeeping: a 2000px conversation in a 500px viewport.
      getAbsoluteLastScrollOffset: jest.fn(() => offset),
      getWindowSize: () => ({ height: 500 }),
      getFirstItemOffset: () => 0,
      getChildContainerDimensions: () => ({ height: 2000 }),
    };
    const listRef = { current: list };
    const ack = jest.fn();
    const fetchNextPage = jest.fn();
    const onNearBottom = jest.fn();
    let hook!: ReturnType<typeof useConversationList>;
    let props = initial;
    function Harness(p: Props) {
      const rows = p.rows ?? [];
      hook = useConversationList({
        listRef,
        rows,
        latestId: rows.length ? 150 : 0,
        target: p.target ?? null,
        oldestId: rows.length ? (rows[0] as { m: { id: number } }).m.id : null,
        newestId: rows.length ? 150 : null,
        history: {
          loaded: true, pageCount: p.pageCount ?? 1, hasNextPage: p.hasNextPage ?? false,
          isFetchingNextPage: false, failed: p.failed ?? false, paused: p.paused ?? false, fetchNextPage,
          refetch: p.refetch ?? (() => Promise.resolve()),
        },
        lastReadId: () => 100,
        ack,
        onNearBottom,
      });
      return null;
    }
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => { tree = TestRenderer.create(React.createElement(Harness, initial)); });
    return {
      list, ack, fetchNextPage, onNearBottom,
      get hook() { return hook; },
      update(next: Partial<Props>) {
        props = { ...props, ...next };
        act(() => tree.update(React.createElement(Harness, props)));
      },
      listLoaded: () => act(() => hook.listProps.onLoad()),
      /** An onScroll at (or away from) the bottom. */
      scroll(atEnd: boolean) {
        act(() => hook.listProps.onScroll({
          nativeEvent: {
            contentOffset: { y: atEnd ? 1500 : 100 },
            layoutMeasurement: { height: 500 },
            contentSize: { height: 2000 },
          },
        } as Parameters<typeof hook.listProps.onScroll>[0]));
      },
      /** The list wrapper's layout, as the keyboard or composer resizes it. */
      resize(height: number) {
        act(() => hook.onViewportLayout({ nativeEvent: { layout: { height } } } as Parameters<typeof hook.onViewportLayout>[0]));
      },
      unmount: () => act(() => tree.unmount()),
    };
  }

  it("leaves FlashList's autoscroll-to-bottom off: follow-latest owns pinning", () => {
    const h = mount();
    const mvcp = h.hook.listProps.maintainVisibleContentPosition;
    expect(mvcp).toEqual({ startRenderingFromBottom: true });
    expect("autoscrollToBottomThreshold" in mvcp).toBe(false);
    h.unmount();
  });

  it("a landing on the newest message reads as at the bottom once it settles", () => {
    // The clamped jump to the end of the list emits no scroll event; only
    // FlashList's own offset (the jump's unclamped target) says where it is.
    const h = mount({ rows: rowsFor(101, 150), target: 150 }, 1730);
    h.listLoaded();
    expect(h.list.scrollToIndex).toHaveBeenCalledWith({ index: 49, animated: false, viewPosition: 0.5 });
    act(() => jest.advanceTimersByTime(SECTION_JUMP_SETTLE_MS));
    expect(h.onNearBottom).toHaveBeenLastCalledWith(true);
    act(() => jest.advanceTimersByTime(1000));
    expect(h.ack).toHaveBeenCalledTimes(1);
    expect(h.ack).toHaveBeenCalledWith(150, expect.any(Function));
    h.unmount();
  });

  it("a landing mid-conversation settles as not at the bottom and acks nothing", () => {
    const h = mount({ rows: rowsFor(101, 150), target: 120 }, 600);
    h.listLoaded();
    act(() => jest.advanceTimersByTime(SECTION_JUMP_SETTLE_MS + 1000));
    expect(h.onNearBottom).toHaveBeenLastCalledWith(false);
    expect(h.ack).not.toHaveBeenCalled();
    h.unmount();
  });

  it("cancelJumps stops a paging landing for good and re-enables acks", () => {
    const h = mount({ rows: rowsFor(101, 150), target: 20, hasNextPage: true });
    h.listLoaded();
    expect(h.fetchNextPage).toHaveBeenCalledTimes(1);
    act(() => h.hook.cancelJumps()); // the jump pill
    h.update({ rows: rowsFor(1, 150), pageCount: 2 });
    act(() => jest.advanceTimersByTime(SECTION_JUMP_SETTLE_MS));
    // The target arriving later must not yank the reader back up.
    expect(h.list.scrollToIndex).not.toHaveBeenCalled();
    expect(h.fetchNextPage).toHaveBeenCalledTimes(1);
    h.scroll(false);
    h.scroll(true);
    act(() => jest.advanceTimersByTime(1000));
    expect(h.ack).toHaveBeenCalledWith(150, expect.any(Function));
    h.unmount();
  });

  it("stale bottom reports mid-landing neither ack nor snap on a viewport shrink", () => {
    const raf = jest.spyOn(global, "requestAnimationFrame").mockImplementation((cb) => { cb(0); return 1; });
    try {
      const h = mount({ rows: rowsFor(101, 150), target: 120 }, 600);
      h.resize(700);
      h.listLoaded();
      // The JS thread was busy: this still reports the pre-jump bottom.
      h.scroll(true);
      // The keyboard goes down mid-landing.
      h.resize(500);
      expect(h.list.scrollToEnd).not.toHaveBeenCalled();
      act(() => jest.advanceTimersByTime(SECTION_JUMP_SETTLE_MS + 1000));
      // The settle re-read restores the truth: mid-conversation.
      expect(h.onNearBottom).toHaveBeenLastCalledWith(false);
      expect(h.ack).not.toHaveBeenCalled();
      h.resize(400);
      expect(h.list.scrollToEnd).not.toHaveBeenCalled();
      h.unmount();
    } finally {
      raf.mockRestore();
    }
  });

  it("stale scroll events mid-landing leave the jump pill alone until the settle re-read", () => {
    const h = mount({ rows: rowsFor(101, 150), target: 120 }, 600);
    h.listLoaded();
    // The JS thread was busy: these still report the pre-jump bottom.
    h.scroll(true);
    h.scroll(false);
    expect(h.onNearBottom).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(SECTION_JUMP_SETTLE_MS));
    expect(h.onNearBottom).toHaveBeenCalledTimes(1);
    expect(h.onNearBottom).toHaveBeenLastCalledWith(false);
    h.unmount();
  });

  it.each([
    ["the jump pill", (hook: ReturnType<typeof useConversationList>) => hook.cancelJumps()],
    ["a rail tap", (hook: ReturnType<typeof useConversationList>) => hook.onRailJump(150)],
  ])("%s ends a fling it interrupts, so new messages pin again", (_, interrupt) => {
    const raf = jest.spyOn(global, "requestAnimationFrame").mockImplementation((cb) => { cb(0); return 1; });
    try {
      const h = mount({ rows: rowsFor(101, 150) }, 1500);
      h.listLoaded();
      act(() => h.hook.listProps.onMomentumScrollBegin());
      // No momentum end: the programmatic scroll swallowed it.
      act(() => interrupt(h.hook));
      act(() => jest.advanceTimersByTime(SECTION_JUMP_SETTLE_MS));
      h.scroll(true);
      h.list.scrollToEnd.mockClear();
      act(() => h.hook.listProps.onContentSizeChange());
      expect(h.list.scrollToEnd).toHaveBeenCalledWith({ animated: false });
      h.unmount();
    } finally {
      raf.mockRestore();
    }
  });

  it("a rail jump re-reads where it ended once it settles", () => {
    const h = mount({ rows: rowsFor(101, 150) }, 1500);
    h.listLoaded();
    act(() => h.hook.onRailJump(150));
    // Its own scroll events say nothing about the bottom while it moves.
    h.scroll(false);
    act(() => jest.advanceTimersByTime(SECTION_JUMP_SETTLE_MS));
    expect(h.onNearBottom).toHaveBeenLastCalledWith(true);
    act(() => jest.advanceTimersByTime(1000));
    expect(h.ack).toHaveBeenCalledWith(150, expect.any(Function));
    h.unmount();
  });
});
