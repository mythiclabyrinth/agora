import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { StyleSheet, Text } from "react-native";
import { colors } from "../src/lib/theme";
import { SwipeRow, createSwipeRowController, shouldIgnoreSwipeRelease } from "../src/components/SwipeRow";
const { __setSwipeProgress } = require("./mocks/reanimatedSwipeable");

const Glyph = (() => null) as any;
const row = () => ({ close: jest.fn(), openLeft: jest.fn(), openRight: jest.fn(), reset: jest.fn() });

it("keeps only one swipe row open and closes it on the next tap or scroll", () => {
  const controller = createSwipeRowController();
  const first = row();
  const second = row();
  controller.opened(first);
  controller.opened(second);
  expect(first.close).toHaveBeenCalledTimes(1);
  expect(controller.consumeTap()).toBe(true);
  expect(second.close).toHaveBeenCalledTimes(1);
  expect(controller.consumeTap()).toBe(false);
  controller.opened(first);
  controller.close();
  expect(first.close).toHaveBeenCalledTimes(2);
});

it("runs left and right actions from swipe buttons and screen-reader actions", () => {
  const markRead = jest.fn();
  const rename = jest.fn();
  const open = jest.fn();
  const controller = createSwipeRowController();
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(SwipeRow, {
      controller, onPress: open, accessibilityLabel: "Unread card",
      swipeLeft: { name: "markRead", label: "Mark read", icon: Glyph, color: "purple", onPress: markRead },
      swipeRight: { name: "rename", label: "Rename", icon: Glyph, color: "red", onPress: rename },
    }, React.createElement(Text, null, "Unread")));
  });
  const button = (label: string) => tree.root.findAll(node => node.props.accessibilityRole === "button")
    .find(node => node.props.accessibilityLabel === label)!;
  act(() => button("Mark read").props.onPress());
  expect(markRead).toHaveBeenCalledTimes(1);
  act(() => button("Rename").props.onPress());
  expect(rename).toHaveBeenCalledTimes(1);
  const content = button("Unread card");
  expect(content.props.accessibilityActions).toEqual([
    { name: "markRead", label: "Mark read" }, { name: "rename", label: "Rename" },
  ]);
  act(() => content.props.onAccessibilityAction({ nativeEvent: { actionName: "markRead" } }));
  act(() => content.props.onAccessibilityAction({ nativeEvent: { actionName: "rename" } }));
  expect(markRead).toHaveBeenCalledTimes(2);
  expect(rename).toHaveBeenCalledTimes(2);
  act(() => content.props.onPress());
  expect(open).toHaveBeenCalledTimes(1);
  act(() => tree.unmount());
});

it("hides swipe actions at rest behind an opaque foreground clipped to the card radius", () => {
  const controller = createSwipeRowController();
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(SwipeRow, {
      controller, onPress: jest.fn(), accessibilityLabel: "Thread card",
      style: { backgroundColor: "rgba(255,255,255,0.028)", borderRadius: 14 },
      swipeLeft: { name: "remove", label: "Remove", icon: Glyph, color: "red", onPress: jest.fn() },
      swipeRight: { name: "rename", label: "Rename", icon: Glyph, color: "purple", onPress: jest.fn() },
    }, React.createElement(Text, null, "Thread")));
  });
  const flat = (style: unknown) => StyleSheet.flatten(style as any) ?? {};
  const container = flat(tree.root.findByProps({ testID: "mock-swipe" }).props.style);
  expect(container).toMatchObject({ overflow: "hidden", borderRadius: 14 });
  const foreground = flat(tree.root.findByProps({ testID: "mock-swipe-foreground" }).props.style);
  expect(foreground).toMatchObject({ backgroundColor: colors.bg, borderRadius: 14 });
  // Action panels only become visible once their side starts opening.
  for (const label of ["Remove", "Rename"]) {
    const button = tree.root.findAll(node => node.props.accessibilityLabel === label && node.props.onPress)[0]!;
    let wrap = button.parent;
    while (wrap && flat(wrap.props.style).opacity === undefined) wrap = wrap.parent;
    expect(flat(wrap?.props.style).opacity).toBe(0);
  }
  act(() => tree.unmount());

  const renderAt = (left: number, right: number) => {
    __setSwipeProgress(left, right);
    act(() => {
      tree = TestRenderer.create(React.createElement(SwipeRow, {
        controller, onPress: jest.fn(), accessibilityLabel: "Thread card",
        style: { backgroundColor: "rgba(255,255,255,0.028)", borderRadius: 14 },
        swipeLeft: { name: "remove", label: "Remove", icon: Glyph, color: "red", onPress: jest.fn() },
        swipeRight: { name: "rename", label: "Rename", icon: Glyph, color: "purple", onPress: jest.fn() },
      }, React.createElement(Text, null, "Thread")));
    });
  };
  const actionOpacity = (label: string) => {
    const button = tree.root.findAll(node => node.props.accessibilityLabel === label && node.props.onPress)[0]!;
    let wrap = button.parent;
    while (wrap && flat(wrap.props.style).opacity === undefined) wrap = wrap.parent;
    return flat(wrap?.props.style).opacity;
  };
  renderAt(1, 0);
  expect(actionOpacity("Rename")).toBe(1);
  expect(actionOpacity("Remove")).toBe(0);
  act(() => tree.unmount());
  renderAt(0, 1);
  expect(actionOpacity("Rename")).toBe(0);
  expect(actionOpacity("Remove")).toBe(1);
  act(() => tree.unmount());
  __setSwipeProgress(0, 0);
});

it("ignores a release press only when the drag opened that same row", () => {
  const controller = createSwipeRowController();
  const openedRow = row();
  controller.opened(openedRow);
  expect(shouldIgnoreSwipeRelease(true, openedRow as any, controller)).toBe(true);
  expect(shouldIgnoreSwipeRelease(false, openedRow as any, controller)).toBe(false);
  expect(shouldIgnoreSwipeRelease(true, row() as any, controller)).toBe(false);
  controller.close();
  expect(shouldIgnoreSwipeRelease(true, openedRow as any, controller)).toBe(false);
});

it("ignores the release after opening, closes on the next tap, then navigates", () => {
  const controller = createSwipeRowController();
  const open = jest.fn();
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(React.createElement(SwipeRow, {
    controller, onPress: open, accessibilityLabel: "Thread card",
    swipeLeft: { name: "remove", label: "Remove", icon: Glyph, color: "red", onPress: jest.fn() },
  }, React.createElement(Text, null, "Thread"))); });
  const swipe = tree.root.findByProps({ testID: "mock-swipe" });
  const content = tree.root.findAll(node => node.props.accessibilityRole === "button" &&
    node.props.accessibilityLabel === "Thread card" && typeof node.props.onPress === "function")[0]!;
  const methods = swipe.props.testSwipeMethods;
  act(() => swipe.props.onSwipeableOpenStartDrag("right"));
  act(() => swipe.props.onSwipeableWillOpen());
  // No onPressIn: the release event itself must be ignored and clear the drag flag.
  act(() => content.props.onPress());
  expect(open).not.toHaveBeenCalled();
  expect(methods.close).not.toHaveBeenCalled();

  // The next tap closes only; another tap navigates.
  act(() => content.props.onPress());
  expect(methods.close).toHaveBeenCalledTimes(1);
  expect(open).not.toHaveBeenCalled();
  act(() => content.props.onPress());
  expect(open).toHaveBeenCalledTimes(1);
  act(() => tree.unmount());
});

it("still opens the item when a drag springs back closed", () => {
  const controller = createSwipeRowController();
  const open = jest.fn();
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(React.createElement(SwipeRow, {
    controller, onPress: open, accessibilityLabel: "Thread card",
    swipeLeft: { name: "remove", label: "Remove", icon: Glyph, color: "red", onPress: jest.fn() },
  }, React.createElement(Text, null, "Thread"))); });
  const swipe = tree.root.findByProps({ testID: "mock-swipe" });
  const content = tree.root.findAll(node => node.props.accessibilityRole === "button" &&
    node.props.accessibilityLabel === "Thread card" && typeof node.props.onPress === "function")[0]!;
  act(() => swipe.props.onSwipeableOpenStartDrag("right"));
  // No onSwipeableWillOpen: the gesture snapped shut before opening.
  act(() => content.props.onPress());
  expect(open).toHaveBeenCalledTimes(1);
  act(() => tree.unmount());
});
