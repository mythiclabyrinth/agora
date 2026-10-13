import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { needsReadAck, trackBottom, useReadAck } from "../src/lib/readAck";

describe("needsReadAck", () => {
  it("acks a message newer than the read marker", () => {
    expect(needsReadAck(137, 12)).toBe(true);
  });

  it("skips messages already read", () => {
    expect(needsReadAck(12, 12)).toBe(false);
    expect(needsReadAck(10, 12)).toBe(false);
  });

  it("skips an empty list", () => {
    expect(needsReadAck(0, undefined)).toBe(false);
    expect(needsReadAck(0, 0)).toBe(false);
  });

  it("acks when the read marker isn't cached yet", () => {
    expect(needsReadAck(5, undefined)).toBe(true);
  });
});

describe("useReadAck", () => {
  type Props = { latestId: number; lastReadId?: number; atBottom: { current: boolean } };
  function mount(initial: Props, ack: jest.Mock) {
    let onReachedBottom: () => void = () => {};
    function Probe(p: Props) {
      onReachedBottom = useReadAck(p.latestId, () => p.lastReadId, ack, p.atBottom);
      return null;
    }
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(Probe, initial));
    });
    return {
      update: (p: Props) => act(() => renderer.update(React.createElement(Probe, p))),
      // As trackBottom does: the ref flips before the callback runs.
      reachBottom: () => act(() => {
        initial.atBottom.current = true;
        onReachedBottom();
      }),
      unmount: () => act(() => renderer.unmount()),
    };
  }

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("acks a message landing while the viewer is at the bottom, debounced", () => {
    const ack = jest.fn();
    const atBottom = { current: true };
    const h = mount({ latestId: 0, atBottom }, ack);
    h.update({ latestId: 5, lastReadId: 3, atBottom });
    h.update({ latestId: 6, lastReadId: 3, atBottom });
    act(() => jest.advanceTimersByTime(600));
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith(6, expect.any(Function));
  });

  it("waits for the viewer to scroll down when they are above the bottom", () => {
    const ack = jest.fn();
    const atBottom = { current: false };
    const h = mount({ latestId: 5, lastReadId: 3, atBottom }, ack);
    act(() => jest.advanceTimersByTime(600));
    expect(ack).not.toHaveBeenCalled();
    h.reachBottom();
    act(() => jest.advanceTimersByTime(600));
    expect(ack).toHaveBeenCalledWith(5, expect.any(Function));
  });

  it("doesn't re-ack the same id while the cached marker lags the server", () => {
    const ack = jest.fn();
    const atBottom = { current: false };
    const h = mount({ latestId: 5, lastReadId: undefined, atBottom }, ack);
    h.reachBottom();
    act(() => jest.advanceTimersByTime(600));
    h.reachBottom();
    act(() => jest.advanceTimersByTime(600));
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it("retries on a later scroll-to-bottom if the ack request failed", () => {
    const ack = jest.fn();
    const atBottom = { current: false };
    const h = mount({ latestId: 5, lastReadId: 3, atBottom }, ack);
    h.reachBottom();
    act(() => jest.advanceTimersByTime(600));
    expect(ack).toHaveBeenCalledTimes(1);
    const onError = ack.mock.calls[0][1] as () => void;
    onError();
    h.reachBottom();
    act(() => jest.advanceTimersByTime(600));
    expect(ack).toHaveBeenCalledTimes(2);
    expect(ack).toHaveBeenLastCalledWith(5, expect.any(Function));
  });

  it("still acks a live message when its arrival briefly shifts the list off the bottom", () => {
    const ack = jest.fn();
    const atBottom = { current: true };
    const h = mount({ latestId: 5, lastReadId: 5, atBottom }, ack);
    h.update({ latestId: 6, lastReadId: 5, atBottom });
    // The new row pushes the viewport up before the list re-pins.
    atBottom.current = false;
    act(() => jest.advanceTimersByTime(600));
    expect(ack).toHaveBeenCalledWith(6, expect.any(Function));
  });

  it("drops a pending ack when the latest id changes to one that's already read", () => {
    const ackA = jest.fn();
    const atBottom = { current: true };
    const h = mount({ latestId: 0, atBottom }, ackA);
    h.update({ latestId: 9, lastReadId: 3, atBottom });
    // Same screen reused for a fully-read conversation before the timer fires.
    h.update({ latestId: 4, lastReadId: 4, atBottom });
    act(() => jest.advanceTimersByTime(600));
    expect(ackA).not.toHaveBeenCalled();
  });

  it("skips already-read messages and cancels on unmount", () => {
    const ack = jest.fn();
    const atBottom = { current: false };
    const h = mount({ latestId: 5, lastReadId: 5, atBottom }, ack);
    h.reachBottom();
    act(() => jest.advanceTimersByTime(600));
    expect(ack).not.toHaveBeenCalled();
    h.update({ latestId: 7, lastReadId: 5, atBottom });
    h.reachBottom();
    h.unmount();
    act(() => jest.advanceTimersByTime(600));
    expect(ack).not.toHaveBeenCalled();
  });
});

describe("trackBottom", () => {
  const at = (y: number) => ({
    contentOffset: { y },
    layoutMeasurement: { height: 500 },
    contentSize: { height: 2000 },
  });

  it("fires once when the list crosses into the bottom, then tracks it", () => {
    const atBottom = { current: false };
    const reached = jest.fn();
    expect(trackBottom(at(100), atBottom, reached)).toBe(false);
    expect(reached).not.toHaveBeenCalled();
    expect(trackBottom(at(1450), atBottom, reached)).toBe(true);
    expect(atBottom.current).toBe(true);
    expect(reached).toHaveBeenCalledTimes(1);
    trackBottom(at(1500), atBottom, reached);
    expect(reached).toHaveBeenCalledTimes(1);
  });

  it("re-fires after leaving the bottom and coming back", () => {
    const atBottom = { current: true };
    const reached = jest.fn();
    trackBottom(at(100), atBottom, reached);
    expect(atBottom.current).toBe(false);
    trackBottom(at(1500), atBottom, reached);
    expect(reached).toHaveBeenCalledTimes(1);
  });
});
