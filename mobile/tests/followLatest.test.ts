import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { movedAwayFromEnd, shouldPinToEnd, useFollowLatest } from "../src/lib/followLatest";
import { trackBottom } from "../src/lib/readAck";

describe("shouldPinToEnd", () => {
  it("pins only a following viewer who isn't touching the list or mid-jump", () => {
    expect(shouldPinToEnd({ following: true, interacting: false, busy: false })).toBe(true);
    expect(shouldPinToEnd({ following: false, interacting: false, busy: false })).toBe(false);
    expect(shouldPinToEnd({ following: true, interacting: true, busy: false })).toBe(false);
    expect(shouldPinToEnd({ following: true, interacting: false, busy: true })).toBe(false);
  });
});

/** Scroll metrics for a 500px viewport. */
const at = (y: number, content: number, viewport = 500) => ({
  contentOffset: { y },
  layoutMeasurement: { height: viewport },
  contentSize: { height: content },
});

describe("movedAwayFromEnd", () => {
  it("counts an upward move past the slop that the layout doesn't explain", () => {
    expect(movedAwayFromEnd(at(1500, 2000), at(0, 2000))).toBe(true);
    expect(movedAwayFromEnd(at(1500, 2000), at(1460, 2000))).toBe(false);
  });

  it("ignores appends and a shrinking scroll range", () => {
    // An append grows the content under a still offset.
    expect(movedAwayFromEnd(at(1500, 2000), at(1500, 2400))).toBe(false);
    // Rows above re-measuring shorter, or the viewport growing (keyboard
    // closing), clamp the offset down by the same amount.
    expect(movedAwayFromEnd(at(1500, 2000), at(1300, 1800))).toBe(false);
    expect(movedAwayFromEnd(at(1500, 2000), at(1200, 2000, 800))).toBe(false);
  });
});

describe("useFollowLatest", () => {
  function setup() {
    const list = { current: { scrollToEnd: jest.fn() } };
    const busy = { current: false };
    const atBottom = { current: false };
    let hook!: ReturnType<typeof useFollowLatest>;
    function Harness() {
      hook = useFollowLatest(list, atBottom, () => busy.current);
      return null;
    }
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => { tree = TestRenderer.create(React.createElement(Harness)); });
    return {
      list, busy, atBottom,
      get hook() { return hook; },
      /** One onScroll, wired as the screens do: trackBottom first. */
      scroll(y: number, content = 2000, viewport = 500) {
        const e = at(y, content, viewport);
        trackBottom(e, atBottom, () => {});
        hook.onScroll(e);
      },
      grow: () => act(() => hook.onContentSizeChange()),
      unmount: () => act(() => tree.unmount()),
    };
  }

  let raf: jest.SpyInstance;
  let cancel: jest.SpyInstance;
  beforeEach(() => {
    raf = jest.spyOn(global, "requestAnimationFrame").mockImplementation((cb) => { cb(0); return 1; });
    cancel = jest.spyOn(global, "cancelAnimationFrame").mockImplementation(() => {});
  });
  afterEach(() => { raf.mockRestore(); cancel.mockRestore(); });

  it("re-pins a burst of arrivals and late row resizes while the viewer follows", () => {
    const h = setup();
    h.scroll(1500);
    // Five quick arrivals, then a chart measuring taller: each growth pins.
    for (let i = 0; i < 5; i += 1) h.grow();
    // An append measured taller than its estimate (Android): the viewer is
    // short of the end, but the offset didn't move up, so still following.
    h.scroll(1500, 2400);
    expect(h.atBottom.current).toBe(false);
    h.grow();
    expect(h.list.current.scrollToEnd).toHaveBeenCalledTimes(6);
    expect(h.list.current.scrollToEnd).toHaveBeenLastCalledWith({ animated: false });
    h.unmount();
  });

  it("drops a queued pin when a jump starts before the frame runs", () => {
    const h = setup();
    h.scroll(1500);
    raf.mockImplementation(() => 1);
    h.grow();
    const queued = raf.mock.calls[raf.mock.calls.length - 1][0] as FrameRequestCallback;
    h.busy.current = true;
    queued(0);
    expect(h.list.current.scrollToEnd).not.toHaveBeenCalled();
    h.unmount();
  });

  it("a jump to a message stops following until the viewer is found at the bottom again", () => {
    const h = setup();
    h.scroll(1500);
    // A landing marks the viewer away from the bottom as it jumps.
    h.atBottom.current = false;
    act(() => h.hook.onJumpAway());
    // The settle re-read couldn't measure the list: nothing re-established
    // following, so an arrival doesn't yank the viewer off the target.
    h.grow();
    expect(h.list.current.scrollToEnd).not.toHaveBeenCalled();
    h.scroll(1500);
    h.grow();
    expect(h.list.current.scrollToEnd).toHaveBeenCalledTimes(1);
    h.unmount();
  });

  it("starts following when a landing marks the viewer at the bottom", () => {
    const h = setup();
    h.grow();
    expect(h.list.current.scrollToEnd).not.toHaveBeenCalled();
    h.atBottom.current = true; // the "newest message" landing, no scroll event
    h.grow();
    expect(h.list.current.scrollToEnd).toHaveBeenCalledTimes(1);
    h.unmount();
  });

  it("never yanks a reader who dragged away, until they come back down", () => {
    const h = setup();
    h.scroll(1500);
    h.hook.onScrollBeginDrag();
    h.grow(); // finger down: never fight it
    h.scroll(1400);
    h.hook.onScrollEndDrag();
    h.hook.onMomentumScrollBegin();
    h.scroll(1300);
    h.hook.onMomentumScrollEnd();
    h.grow();
    expect(h.list.current.scrollToEnd).not.toHaveBeenCalled();
    h.scroll(1500);
    h.grow();
    expect(h.list.current.scrollToEnd).toHaveBeenCalledTimes(1);
    h.unmount();
  });

  it("pins again after a programmatic scroll swallows a fling's momentum end", () => {
    const h = setup();
    h.hook.onScrollBeginDrag();
    h.scroll(1400);
    h.hook.onScrollEndDrag();
    h.hook.onMomentumScrollBegin();
    // The jump pill's scrollToEnd interrupts the fling: no momentum end.
    h.hook.onProgrammaticScroll();
    h.scroll(1500);
    h.grow();
    expect(h.list.current.scrollToEnd).toHaveBeenCalledTimes(1);
    h.unmount();
  });

  it("a programmatic scroll doesn't override a finger still on the list", () => {
    const h = setup();
    h.scroll(1500);
    h.hook.onScrollBeginDrag();
    h.hook.onProgrammaticScroll();
    h.scroll(1500);
    h.grow();
    expect(h.list.current.scrollToEnd).not.toHaveBeenCalled();
    h.unmount();
  });

  it("catching a fling ends it even if its momentum end never arrives", () => {
    const h = setup();
    h.hook.onMomentumScrollBegin();
    h.hook.onScrollBeginDrag();
    h.scroll(1500);
    h.hook.onScrollEndDrag();
    h.grow();
    expect(h.list.current.scrollToEnd).toHaveBeenCalledTimes(1);
    h.unmount();
  });

  it("stops following on a scroll to the top with no gesture (iOS status-bar tap)", () => {
    const h = setup();
    h.scroll(1500);
    h.scroll(700);
    h.scroll(0);
    h.grow();
    expect(h.list.current.scrollToEnd).not.toHaveBeenCalled();
    h.unmount();
  });

  it("stops following when a programmatic jump moves the viewer away", () => {
    const h = setup();
    h.scroll(1500);
    h.busy.current = true;
    h.grow(); // a landing owns the position meanwhile
    // Short of the end without a move up: drift while idle, a jump while busy.
    h.scroll(1450, 2100);
    h.busy.current = false;
    h.grow();
    expect(h.list.current.scrollToEnd).not.toHaveBeenCalled();
    h.unmount();
  });
});
