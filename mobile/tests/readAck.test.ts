import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { needsReadAck, useReadAck } from "../src/lib/readAck";

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
      reachBottom: () => act(() => onReachedBottom()),
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
    expect(ack).toHaveBeenCalledWith(6);
  });

  it("waits for the viewer to scroll down when they are above the bottom", () => {
    const ack = jest.fn();
    const atBottom = { current: false };
    const h = mount({ latestId: 5, lastReadId: 3, atBottom }, ack);
    act(() => jest.advanceTimersByTime(600));
    expect(ack).not.toHaveBeenCalled();
    h.reachBottom();
    act(() => jest.advanceTimersByTime(600));
    expect(ack).toHaveBeenCalledWith(5);
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
