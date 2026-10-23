import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FlatList, StyleSheet, TextInput } from "react-native";
import { ThreadsScreen, ThreadViewSheet } from "../app/(app)/threads";
import { fixtureThreads } from "@agora/core/testing/fixtures";
import { usePrefs } from "../src/state/prefs";

jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));
jest.mock("expo-router", () => ({ Stack: { Screen: () => null }, router: { push: jest.fn() } }));
jest.mock("../src/components/SwipeRow", () => ({
  SwipeRow: ({ children }: React.PropsWithChildren) => children,
  useSwipeRows: () => ({ close: jest.fn() }),
}));
jest.mock("@agora/core", () => ({
  ...jest.requireActual("@agora/core"),
  useThreads: () => ({ data: require("@agora/core/testing/fixtures").fixtureThreads.map((thread: typeof fixtureThreads[number]) => ({
    ...thread, root: { ...thread.root, alias: null, text: "**Deploy** plan\nfor Friday" },
  })) }),
  useGroups: () => ({ data: require("@agora/core/testing/fixtures").fixtureGroups, isSuccess: true }),
  useRenameThread: () => ({}),
  useHideThread: () => ({}),
  useUnhideThread: () => ({}),
  useSyncedDrafts: () => [],
}));

it("searches and clears rows, opens options, and announces active filters", () => {
  usePrefs.setState({ threadSort: "recent", threadFilter: "all", threadGroup: null });
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(React.createElement(ThreadsScreen, { embedded: true })); });
  const input = () => tree.root.findByType(TextInput);
  const rows = () => tree.root.findByType(FlatList).props.data;
  expect(rows()).toHaveLength(fixtureThreads.length);
  act(() => input().props.onChangeText("no such conversation"));
  expect(rows()).toHaveLength(0);
  expect(tree.root.findAll(node => node.props.children === "No matching threads").length).toBeGreaterThan(0);
  act(() => input().props.onChangeText(fixtureThreads[0].channel_name.toUpperCase()));
  expect(rows()).toHaveLength(fixtureThreads.length);
  act(() => input().props.onChangeText(""));
  expect(rows()).toHaveLength(fixtureThreads.length);
  for (const query of ["friday", "deploy plan"]) {
    act(() => input().props.onChangeText(query));
    expect(rows()).toHaveLength(fixtureThreads.length);
  }
  act(() => input().props.onChangeText("**deploy**"));
  expect(rows()).toHaveLength(0);
  act(() => input().props.onChangeText(""));
  expect(tree.root.findByType(FlatList).props.keyboardShouldPersistTaps).toBe("handled");
  expect(tree.root.findByType(FlatList).props.keyboardDismissMode).toBe("on-drag");
  expect(StyleSheet.flatten(input().props.style).borderWidth).toBeUndefined();
  expect(input().props.selectionColor).toBeTruthy();
  expect(["light", "dark"]).toContain(input().props.keyboardAppearance);
  expect(input().props.clearButtonMode).toBe("while-editing");
  const trigger = () => tree.root.find(node => node.props.accessibilityRole === "button"
    && node.props.accessibilityLabel?.startsWith("Thread view options"));
  expect(trigger().props.accessibilityLabel).toBe("Thread view options");
  act(() => trigger().props.onPress());
  expect(tree.root.findByProps({ testID: "thread-view-sheet" })).toBeTruthy();
  act(() => tree.root.findByType(ThreadViewSheet).props.onSort("az"));
  expect(trigger().props.accessibilityLabel).toBe("Thread view options, filters active");
  act(() => tree.root.findByType(ThreadViewSheet).props.onClose());
  expect(tree.root.findAllByType(ThreadViewSheet)).toHaveLength(0);
  act(() => tree.unmount());
  usePrefs.setState({ threadSort: "recent" });
});
