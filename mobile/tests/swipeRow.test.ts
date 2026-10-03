import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Text } from "react-native";
import { SwipeRow, createSwipeRowController } from "../src/components/SwipeRow";

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
