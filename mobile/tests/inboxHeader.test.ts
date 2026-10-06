import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { ScrollView, StyleSheet } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useMarkUnreadsRead, useUnreads } from "@agora/core";
import InboxScreen from "../app/(app)/inbox";
import { useInboxTab } from "../src/state/inboxTab";

jest.mock("@agora/core", () => ({
  ...jest.requireActual("@agora/core"), useUnreads: jest.fn(), useMarkUnreadsRead: jest.fn(),
}));
jest.mock("expo-router", () => ({ Stack: { Screen: () => null }, router: { push: jest.fn() }, useLocalSearchParams: jest.fn() }));
jest.mock("../app/(app)/threads", () => ({ ThreadsScreen: () => null }));
jest.mock("lucide-react-native", () => new Proxy({}, { get: () => function MockIcon() { return null; } }));
jest.mock("../src/components/SwipeRow", () => ({
  SwipeRow: ({ children }: React.PropsWithChildren) => children,
  useSwipeRows: () => ({ close: jest.fn() }),
}));

const channel = { kind: "channel", channel_id: "general", channel_name: "general", group_id: "team", group_name: "Team", thread_id: null,
  unread: 2, mentions: 0, first_unread_id: 1, ack_through_id: 2, latest_ts: 1, previews: [] };
const thread = { ...channel, kind: "thread", thread_id: 42, title: "A thread", unread: 3, mentions: 1 };
const mutate = jest.fn();
const query = { data: [channel, thread], total: 2, isLoading: false, isError: false, refetch: jest.fn() };
let tree: TestRenderer.ReactTestRenderer;
beforeEach(() => {
  jest.clearAllMocks();
  useInboxTab.setState({ tab: "unreads", filter: "all" });
  (useUnreads as jest.Mock).mockReturnValue(query);
  (useMarkUnreadsRead as jest.Mock).mockReturnValue({ mutate, isPending: false });
  (useLocalSearchParams as jest.Mock).mockReturnValue({});
});
afterEach(() => act(() => tree?.unmount()));
function render() { act(() => { tree = TestRenderer.create(React.createElement(InboxScreen)); }); }
function tabs() { return tree.root.findAll((node) => node.props.accessibilityRole === "tab" && typeof node.props.onPress === "function"); }
function button(label: string) {
  return tree.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0];
}

test("Inbox remembers the selected tab across screen remounts", () => {
  render();
  expect(tabs()[0].props.accessibilityState.selected).toBe(true);
  expect(tabs()[0].props.accessibilityLabel).toBe("Unreads, 5 unread messages");
  act(() => tabs().find((node) => node.props.accessibilityLabel === "Threads")!.props.onPress());
  expect(button("Mark all read")).toBeUndefined();
  (useUnreads as jest.Mock).mockReturnValue({ ...query, data: [], total: 0 });
  act(() => tree.update(React.createElement(InboxScreen)));
  expect(tabs().find((node) => node.props.accessibilityLabel === "Threads")!.props.accessibilityState.selected).toBe(true);
  act(() => tree.unmount());
  render();
  expect(tabs().find((node) => node.props.accessibilityLabel === "Threads")!.props.accessibilityState.selected).toBe(true);
  act(() => tabs().find((node) => node.props.accessibilityLabel === "Unreads")!.props.onPress());
  expect(tabs()[0].props.accessibilityState.selected).toBe(true);
});

test("empty inbox defaults to Unreads on a new session", () => {
  (useUnreads as jest.Mock).mockReturnValue({ ...query, data: [], total: 0 });
  render();
  expect(tabs()[0].props.accessibilityState.selected).toBe(true);
});

test("Inbox remembers the unread filter across screen remounts", () => {
  render();
  act(() => button("Filter unreads: mentions").props.onPress());
  expect(useInboxTab.getState().filter).toBe("mentions");
  act(() => tree.unmount());
  render();
  expect(button("Filter unreads: mentions").props.accessibilityState.selected).toBe(true);
});

test("incoming Threads deep links select the correct tab", () => {
  (useLocalSearchParams as jest.Mock).mockReturnValue({ tab: "threads" });
  render();
  expect(tabs().find((node) => node.props.accessibilityLabel === "Threads")!.props.accessibilityState.selected).toBe(true);
});

test("mark read targets the current filter and retains an accessible 44 point action", () => {
  render();
  const mark = button("Mark all read");
  expect(StyleSheet.flatten(mark.props.style)).toMatchObject({ width: 44, minHeight: 44, alignItems: "center", justifyContent: "center" });
  expect(tree.root.findAllByType(ScrollView).some((node) => node.props.horizontal)).toBe(true);
  act(() => button("Filter unreads: mentions").props.onPress());
  act(() => button("Mark these read").props.onPress());
  expect(mutate).toHaveBeenCalledWith([thread], expect.any(Object));
});

test("limited unread results do not advertise an inaccurate total", () => {
  (useUnreads as jest.Mock).mockReturnValue({ ...query, total: 10 });
  render();
  expect(tabs()[0].props.accessibilityLabel).toBe("Unreads");
  expect(button("Mark shown read")).toBeDefined();
});

test("pending mark-read requests disable the action and expose progress", () => {
  (useMarkUnreadsRead as jest.Mock).mockReturnValue({ mutate, isPending: true });
  render();
  expect(button("Mark all read").props.disabled).toBe(true);
  expect(button("Mark all read").props.accessibilityState).toEqual({ disabled: true, busy: true });
});
