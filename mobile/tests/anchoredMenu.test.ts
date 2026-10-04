import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Modal, ScrollView, StyleSheet, View } from "react-native";
import { AnchoredMenu, menuPosition } from "../src/components/AnchoredMenu";
import { ParticipantAccessFields } from "../src/components/ParticipantAccessFields";
jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));

test("short menus sit directly beneath their anchor", () => {
  const position = menuPosition({ x: 21, y: 580, width: 360, height: 48 }, 402, 874, 102);
  expect(position.top).toBe(634); expect(position.width).toBe(360);
});
test("menus near the bottom sit directly above their anchor", () => {
  expect(menuPosition({ x: 21, y: 760, width: 360, height: 48 }, 402, 874, 150).top).toBe(604);
});
test("menus remain inside a keyboard-reduced viewport", () => {
  const position = menuPosition({ x: 300, y: 700, width: 96, height: 44 }, 402, 420, 150);
  expect(position.top + position.maxHeight).toBeLessThanOrEqual(396);
  expect(position.left + position.width).toBeLessThanOrEqual(386);
});
test("overlay positioning uses actual content height instead of reserving the maximum", () => {
  const anchor = { current: { measureInWindow: (callback: (...args: number[]) => void) => callback(20, 600, 300, 48) } } as React.RefObject<View>;
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(React.createElement(AnchoredMenu, { anchor, label: "Channels", menuHeight: 340, onClose: jest.fn(), children: React.createElement(View) })); });
  expect(tree.root.findAllByType(Modal)).toHaveLength(1);
  act(() => tree.root.findByType(ScrollView).props.onContentSizeChange(300, 92));
  const style = StyleSheet.flatten(tree.root.findByProps({ testID: "anchored-menu" }).props.style);
  expect(style.position).toBe("absolute"); expect(style.maxHeight).toBeLessThan(120);
  act(() => tree.unmount());
});
test("selected channels have a bounded independent scroll area", () => {
  const channels = Array.from({ length: 12 }, (_, index) => ({ id: String(index), name: "channel-" + index }));
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(React.createElement(ParticipantAccessFields, { channels, permissions: { groupAdmin: true, channelIds: [] },
    value: { mode: "channels", role: "member", channels: Object.fromEntries(channels.map(channel => [channel.id, "member" as const])) }, onChange: jest.fn() })); });
  const scroll = tree.root.findByProps({ testID: "selected-channel-roles" });
  expect(StyleSheet.flatten(scroll.props.style).maxHeight).toBe(224);
  expect(scroll.props.nestedScrollEnabled).toBe(true);
  act(() => tree.unmount());
});

test("channel multi-select keeps the parent layout unchanged until Done and cancels on dismissal", () => {
  const onChange = jest.fn();
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(React.createElement(ParticipantAccessFields, {
    channels: [{ id: "reading", name: "reading" }], permissions: { groupAdmin: true, channelIds: [] },
    value: { mode: "channels", role: "member", channels: {} }, onChange,
  })); });
  const press = (label: string) => act(() => tree.root.findAllByProps({ accessibilityLabel: label })[0].props.onPress());
  press("Select channels"); press("Select #reading");
  expect(onChange).not.toHaveBeenCalled();
  expect(tree.root.findAllByProps({ testID: "selected-channel-roles" })).toHaveLength(0);
  press("Dismiss Channels");
  expect(onChange).not.toHaveBeenCalled();
  press("Select channels");
  expect(tree.root.findAllByProps({ accessibilityLabel: "Select #reading" })[0].props.accessibilityState.checked).toBe(false);
  press("Select #reading"); press("Done selecting channels");
  expect(onChange).toHaveBeenCalledWith({ mode: "channels", role: "member", channels: { reading: "member" } });
  act(() => tree.unmount());
});
