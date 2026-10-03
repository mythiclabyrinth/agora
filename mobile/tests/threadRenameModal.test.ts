import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { StyleSheet, TextInput } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiClient, ApiProvider, type ThreadRow } from "@agora/core";
import { RenameModal, ThreadViewSheet } from "../app/(app)/threads";
import { SelectDropdown } from "../src/components/SelectDropdown";
import { colors } from "../src/lib/theme";

jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));
jest.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  router: { push: jest.fn() },
}));

const thread = {
  root: { id: 42, alias: "Launch notes", text: "Original thread message" },
} as ThreadRow;

it("renders the rename dialog on an opaque accessible modal surface", () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const api = new ApiClient({ baseUrl: "https://agora.example", token: "test" });
  const onClose = jest.fn();
  let tree!: TestRenderer.ReactTestRenderer;

  act(() => {
    tree = TestRenderer.create(React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        ApiProvider,
        { client: api },
        React.createElement(RenameModal, { thread, onClose }),
      ),
    ));
  });

  const dialog = tree.root.findByProps({ testID: "rename-thread-dialog" });
  const backgroundColor = StyleSheet.flatten(dialog.props.style).backgroundColor;
  expect(dialog.props.accessibilityViewIsModal).toBe(true);
  expect(dialog.props.accessibilityLabel).toBe("Rename thread dialog");
  expect(backgroundColor).toBe(colors.sheet);
  expect(backgroundColor).toMatch(/^#[0-9a-f]{6}$/i);
  expect(tree.root.findByType(TextInput).props.value).toBe("Launch notes");

  const backdrop = tree.root.find((node) => node.props.onPress === onClose);
  act(() => backdrop.props.onPress());
  expect(onClose).toHaveBeenCalledTimes(1);

  act(() => tree.unmount());
  queryClient.clear();
});

it("applies thread view choices immediately and closes from its controls", () => {
  const onSort = jest.fn();
  const onFilter = jest.fn();
  const onGroup = jest.fn();
  const onClose = jest.fn();
  let tree!: TestRenderer.ReactTestRenderer;

  act(() => {
    tree = TestRenderer.create(React.createElement(ThreadViewSheet, {
      sort: "recent",
      filter: "all",
      groupId: null,
      groupOptions: [{ id: "product", name: "Product" }],
      onSort,
      onFilter,
      onGroup,
      onClose,
    }));
  });

  const sheet = tree.root.findByProps({ testID: "thread-view-sheet" });
  expect(sheet.props.accessibilityViewIsModal).toBe(true);
  expect(sheet.props.accessibilityLabel).toBe("Thread view options");
  act(() => {
    tree.root.findByProps({ testID: "thread-view-controls" }).props.onLayout({ nativeEvent: { layout: { y: 70 } } });
    tree.root.findAllByType(SelectDropdown).forEach((control, index) =>
      control.props.onLayout({ nativeEvent: { layout: { y: index * 74, height: 62 } } }));
  });

  const trigger = (label: string) => tree.root.find((node) => node.props.accessibilityRole === "button"
    && typeof node.props.accessibilityLabel === "string"
    && node.props.accessibilityLabel.startsWith(`${label}: `));
  const option = (label: string) => tree.root.find((node) => node.props.accessibilityRole === "menuitem"
    && node.props.accessibilityLabel === label);
  expect(trigger("Sort by").props.accessibilityState).toEqual({ expanded: false });
  act(() => trigger("Sort by").props.onPress());
  expect(trigger("Sort by").props.accessibilityState).toEqual({ expanded: true });
  const az = option("A–Z");
  act(() => az.props.onPress());
  expect(trigger("Sort by").props.accessibilityState).toEqual({ expanded: false });
  act(() => trigger("Show").props.onPress());
  const saved = option("Saved Threads");
  act(() => saved.props.onPress());
  expect(onSort).toHaveBeenCalledWith("az");
  expect(onFilter).toHaveBeenCalledWith("saved");
  act(() => trigger("Group").props.onPress());
  act(() => option("Product").props.onPress());
  expect(onGroup).toHaveBeenCalledWith("product");
  act(() => {
    tree.root.findByProps({ testID: "thread-view-controls" }).props.onLayout({ nativeEvent: { layout: { y: 0 } } });
    tree.root.findAllByType(SelectDropdown)[2].props.onLayout({ nativeEvent: { layout: { y: 0, height: 62 } } });
  });
  act(() => trigger("Group").props.onPress());
  expect(option("Product")).toBeTruthy();

  const done = tree.root.find((node) => node.props.accessibilityRole === "button"
    && node.findAll((child) => child.props.children === "Done").length > 0);
  act(() => done.props.onPress());
  expect(onClose).toHaveBeenCalledTimes(1);

  act(() => tree.unmount());
});
