import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { LayoutChangeEvent } from "react-native";
import { useBottomViewport } from "../src/lib/useBottomViewport";

it("keeps the latest message visible on viewport shrink without moving older history", () => {
  const list = { current: { scrollToEnd: jest.fn() } };
  const atBottom = { current: true };
  let handler!: (event: LayoutChangeEvent) => void;
  const raf = jest.spyOn(global, "requestAnimationFrame").mockImplementation(callback => { callback(0); return 1; });
  const cancel = jest.spyOn(global, "cancelAnimationFrame").mockImplementation(() => {});
  function Harness() { handler = useBottomViewport(list, atBottom); return null; }
  let tree!: TestRenderer.ReactTestRenderer;
  const resize = (height: number) => act(() => handler({ nativeEvent: { layout: { height } } } as LayoutChangeEvent));
  try {
    act(() => { tree = TestRenderer.create(React.createElement(Harness)); });
    resize(600);
    expect(list.current.scrollToEnd).not.toHaveBeenCalled();
    resize(450);
    expect(list.current.scrollToEnd).toHaveBeenCalledWith({ animated: false });
    atBottom.current = false;
    resize(350);
    resize(500);
    expect(list.current.scrollToEnd).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  } finally { raf.mockRestore(); cancel.mockRestore(); }
});
