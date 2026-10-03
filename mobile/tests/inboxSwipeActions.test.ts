import React from "react";
import { unreadSwipeAction } from "../app/(app)/inbox";
import { threadSwipeActions } from "../app/(app)/threads";
import type { ThreadRow, UnreadItem } from "@agora/core";

jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));
jest.mock("expo-router", () => ({
  Redirect: () => null, Stack: { Screen: () => null }, router: { push: jest.fn() },
  useLocalSearchParams: () => ({}),
}));
jest.mock("../src/components/SwipeRow", () => ({
  SwipeRow: jest.fn(({ children }: { children: unknown }) => children),
  useSwipeRows: () => ({ close: jest.fn() }),
}));

it("marks the exact unread card from its left swipe action", () => {
  const item = { kind: "channel", channel_id: "main" } as UnreadItem;
  const onRead = jest.fn();
  const action = unreadSwipeAction(item, onRead);
  expect(action.name).toBe("markRead");
  action.onPress();
  expect(onRead).toHaveBeenCalledWith(item);
});

it("renders unread counts without an inline mark button and exposes only the left swipe", () => {
  const { UnreadRow } = require("../app/(app)/inbox") as typeof import("../app/(app)/inbox");
  const { SwipeRow } = require("../src/components/SwipeRow");
  const item = {
    kind: "channel", channel_id: "main", channel_name: "general", group_id: "product", group_name: "Product",
    thread_id: null, title: null, unread: 2, mentions: 1, first_unread_id: 44, ack_through_id: 45,
    latest_ts: 0, previews: [],
  } as unknown as UnreadItem;
  let tree!: import("react-test-renderer").ReactTestRenderer;
  const TestRenderer = require("react-test-renderer");
  TestRenderer.act(() => {
    tree = TestRenderer.create(React.createElement(UnreadRow, {
      item, onRead: jest.fn(), controller: { close: jest.fn(), isOpen: jest.fn() } as any,
    }));
  });
  const rendered = JSON.stringify(tree!.toJSON());
  expect(rendered).toContain('"2"');
  expect(rendered).toContain('"  @1"');
  expect(tree!.root.findAll((node: any) => node.props.accessibilityLabel === "Mark channel read")).toHaveLength(0);
  expect(tree!.root.findAll((node: any) => node.children?.includes("✓"))).toHaveLength(0);
  const swipeRowProps = SwipeRow.mock.calls.at(-1)![0];
  expect(swipeRowProps.swipeLeft.label).toBe("Mark read");
  expect(swipeRowProps.swipeRight).toBeUndefined();
  TestRenderer.act(() => tree!.unmount());
});

it("routes a left thread swipe to Remove and a right swipe to Rename", () => {
  const thread = { root: { id: 42 } } as ThreadRow;
  const onRename = jest.fn();
  const onRemove = jest.fn();
  const { swipeLeft, swipeRight } = threadSwipeActions(thread, onRename, onRemove);
  expect(swipeLeft.name).toBe("remove");
  expect(swipeLeft.label).toBe("Remove");
  expect(swipeRight.name).toBe("rename");
  expect(swipeRight.label).toBe("Rename");
  swipeLeft.onPress();
  swipeRight.onPress();
  expect(onRemove).toHaveBeenCalledTimes(1);
  expect(onRename).toHaveBeenCalledWith(thread);
});
