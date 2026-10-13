import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { Message } from "@agora/core";
import {
  SECTION_JUMP_PASSES_MS,
  SECTION_JUMP_SETTLE_MS,
  useSectionJump,
} from "../src/components/SectionRail";
import { trackBottom, useReadAck } from "../src/lib/readAck";
import {
  AWAIT_TARGET_MS,
  LANDING_HIGHLIGHT_MS,
  MAX_LANDING_PAGES,
  landingStep,
  parseMessageId,
  useMessageLanding,
} from "../src/lib/useMessageLanding";

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
    expect(landingStep({ ...base, oldestId: 10 })).toBe("giveUp");
    expect(landingStep({ ...base, pagesFetched: MAX_LANDING_PAGES })).toBe("giveUp");
    expect(landingStep({ ...base, failed: true })).toBe("giveUp");
    expect(landingStep({ ...base, hasNextPage: false })).toBe("giveUp");
  });

  it("awaits a target newer than the loaded history instead of calling it gone", () => {
    const newer = { ...base, target: 160, oldestId: 101 };
    expect(landingStep(newer)).toBe("await");
    expect(landingStep({ ...newer, newestId: null, oldestId: null })).toBe("await");
    expect(landingStep({ ...newer, waitedOut: true })).toBe("giveUp");
  });

  it("awaits while the newest page refetches, until the wait runs out", () => {
    const gone = { ...base, target: 120 };
    expect(landingStep(gone)).toBe("giveUp");
    expect(landingStep({ ...gone, refreshing: true })).toBe("await");
    expect(landingStep({ ...gone, refreshing: true, waitedOut: true })).toBe("giveUp");
  });

  it("never pages for a target that loads on its own", () => {
    const root = { ...base, target: 5, separate: true };
    expect(landingStep(root)).toBe("await");
    expect(landingStep({ ...root, waitedOut: true })).toBe("giveUp");
    expect(landingStep({ ...root, found: true })).toBe("land");
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
    separateTarget?: boolean;
    loaded?: boolean;
    dividerReady?: boolean;
    dividerMessageId?: number | null;
    latestId?: number;
    lastReadId?: number;
  };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function mount(initial: Props) {
    const list = { scrollToIndex: jest.fn(), scrollToEnd: jest.fn() };
    const listRef = { current: list };
    const fetchNextPage = jest.fn();
    const ack = jest.fn();
    const atBottom = { current: false };
    const rereadPosition = jest.fn(() => false);
    let landing!: ReturnType<typeof useMessageLanding>;
    let onReachedBottom!: () => void;
    let props = initial;
    function Harness(p: Props) {
      const msgs = p.rows.filter((r) => (r as { kind: string }).kind === "msg") as { m: Message }[];
      const oldest = msgs[0];
      const newest = msgs[msgs.length - 1];
      const latestId = p.latestId ?? 150;
      const { jumpToSection, cancelSectionJump } = useSectionJump({ listRef, rows: p.rows, atBottom, latestId });
      landing = useMessageLanding({
        target: p.target,
        nonce: p.nonce,
        rows: p.rows,
        oldestId: oldest?.m.id ?? null,
        newestId: newest?.m.id ?? null,
        separateTarget: p.separateTarget,
        history: {
          loaded: p.loaded ?? true,
          pageCount: p.pageCount,
          hasNextPage: p.hasNextPage ?? true,
          isFetchingNextPage: p.isFetchingNextPage ?? false,
          failed: p.failed ?? false,
          refreshing: p.refreshing,
          fetchNextPage,
        },
        dividerReady: p.dividerReady,
        dividerMessageId: p.dividerMessageId,
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
      list, fetchNextPage, ack, atBottom, rereadPosition,
      get landing() { return landing; },
      update(next: Partial<Props>) {
        props = { ...props, ...next };
        act(() => tree.update(React.createElement(Harness, props)));
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

  it("falls back to the divider when the target is gone", () => {
    const h = mount({
      target: 104, rows: rowsFor(101, 150, 110).filter((r) => (r as { m?: Message }).m?.id !== 104),
      pageCount: 1, dividerMessageId: 111,
    });
    h.listLoaded();
    expect(h.fetchNextPage).not.toHaveBeenCalled();
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
    it("opens on a message newer than the stale cache once it arrives", () => {
      const h = mount({ target: 160, rows: rowsFor(101, 150), pageCount: 1 });
      h.listLoaded();
      // Newer than anything loaded: not gone, and not something paging brings.
      expect(h.fetchNextPage).not.toHaveBeenCalled();
      expect(h.list.scrollToEnd).not.toHaveBeenCalled();
      expect(h.landing.decided).toBe(false);
      act(() => jest.advanceTimersByTime(2000));
      // The foreground refetch (or the socket) brings it.
      h.update({ rows: rowsFor(101, 165) });
      expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 59, animated: false, viewPosition: 0.5 });
      expect(h.landing.highlightedId).toBe(160);
      h.unmount();
    });

    it("awaits the newest page's refetch before calling a target gone", () => {
      const without120 = rowsFor(101, 150).filter((r) => (r as { m: Message }).m.id !== 120);
      const h = mount({ target: 120, rows: without120, pageCount: 1, refreshing: true });
      h.listLoaded();
      expect(h.landing.decided).toBe(false);
      h.update({ rows: rowsFor(101, 150), refreshing: false });
      expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 19, animated: false, viewPosition: 0.5 });
      h.unmount();
    });

    it("falls back to the divider when an opening target never arrives", () => {
      const h = mount({ target: 160, rows: rowsFor(101, 150, 140), pageCount: 1, dividerMessageId: 141 });
      h.listLoaded();
      act(() => jest.advanceTimersByTime(AWAIT_TARGET_MS - 1));
      expect(h.list.scrollToIndex).not.toHaveBeenCalled();
      act(() => jest.advanceTimersByTime(1));
      expect(h.fetchNextPage).not.toHaveBeenCalled();
      expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 41, animated: false, viewPosition: 0.2 });
      expect(h.landing.highlightedId).toBeNull();
      h.unmount();
    });

    it("still wakes at the deadline after a refetch interrupted the wait", () => {
      const h = mount({ target: 160, rows: rowsFor(101, 150), pageCount: 1 });
      h.listLoaded();
      act(() => jest.advanceTimersByTime(2000));
      // A refetch in between briefly turns the step into something else and
      // back to awaiting; the original deadline must still fire.
      h.update({ refreshing: true });
      h.update({ refreshing: false });
      act(() => jest.advanceTimersByTime(AWAIT_TARGET_MS - 2000));
      expect(h.list.scrollToEnd).toHaveBeenCalledWith({ animated: false });
      expect(h.landing.decided).toBe(true);
      h.unmount();
    });

    it("falls back to the newest message when there's no divider", () => {
      const h = mount({ target: 160, rows: rowsFor(101, 150), pageCount: 1 });
      h.listLoaded();
      act(() => jest.advanceTimersByTime(AWAIT_TARGET_MS));
      expect(h.list.scrollToEnd).toHaveBeenCalledWith({ animated: false });
      expect(h.atBottom.current).toBe(true);
      expect(h.landing.decided).toBe(true);
      h.unmount();
    });

    it("leaves the viewport alone when an in-place target never arrives", () => {
      const h = mount({ target: null, rows: rowsFor(101, 150), pageCount: 1 });
      h.listLoaded();
      expect(h.atBottom.current).toBe(true);
      h.update({ target: 170, nonce: "tap1" });
      expect(h.atBottom.current).toBe(false);
      act(() => jest.advanceTimersByTime(AWAIT_TARGET_MS));
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

    it("waits for a targeted thread root instead of paging the replies", () => {
      const h = mount({ target: 5, rows: rowsFor(101, 150), pageCount: 1, separateTarget: true });
      h.listLoaded();
      expect(h.fetchNextPage).not.toHaveBeenCalled();
      expect(h.landing.decided).toBe(false);
      // The root's own fetch resolves: its row goes on top.
      h.update({ rows: [{ kind: "root", m: message(5) }, ...rowsFor(101, 150)] });
      expect(h.list.scrollToIndex).toHaveBeenLastCalledWith({ index: 0, animated: false, viewPosition: 0.5 });
      expect(h.landing.highlightedId).toBe(5);
      expect(h.fetchNextPage).not.toHaveBeenCalled();
      h.unmount();
    });

    it("gives up on a thread root that never loads, without paging", () => {
      const h = mount({ target: 5, rows: rowsFor(101, 150), pageCount: 1, separateTarget: true });
      h.listLoaded();
      act(() => jest.advanceTimersByTime(AWAIT_TARGET_MS));
      expect(h.fetchNextPage).not.toHaveBeenCalled();
      expect(h.landing.decided).toBe(true);
      h.unmount();
    });
  });

  it("an opening target that can't be found waits for the read marker before falling back", () => {
    const without104 = (divider?: number) =>
      rowsFor(101, 150, divider).filter((r) => (r as { m?: Message }).m?.id !== 104);
    const h = mount({ target: 104, rows: without104(), pageCount: 1, dividerReady: false });
    h.listLoaded();
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
