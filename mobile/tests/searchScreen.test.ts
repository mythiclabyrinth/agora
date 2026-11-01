import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FlatList, SectionList, Text, TextInput } from "react-native";
import { router } from "expo-router";
import { useAskAi, useGroups, useMe } from "@agora/core";
import { fixtureGroups } from "@agora/core/testing/fixtures";
import SearchScreen from "../app/(app)/search";
import { useSearchResults, type SearchResults } from "../src/lib/useSearchResults";
import { useSession } from "../src/state/session";
import { toastErr } from "../src/components/Toast";

jest.mock("lucide-react-native", () => new Proxy({}, { get: () => function MockIcon() { return null; } }));
jest.mock("expo-router", () => ({ Stack: { Screen: () => null }, router: { push: jest.fn() } }));
jest.mock("../src/lib/useSearchResults", () => ({ useSearchResults: jest.fn() }));
jest.mock("../src/components/Toast", () => ({ toastErr: jest.fn() }));
jest.mock("@agora/core", () => ({ ...jest.requireActual("@agora/core"), useGroups: jest.fn(), useMe: jest.fn(), useAskAi: jest.fn() }));

const thread = { id: 42, alias: "Release plan", channel_id: "general", channel_name: "general", group_id: "product", group_name: "Product", reply_count: 3, last_activity: 1793500000 };
let state: SearchResults;
let tree: TestRenderer.ReactTestRenderer;
const button = (label: string) => tree.root.findAll(n => n.props.accessibilityLabel === label && typeof n.props.onPress === "function")[0];
const text = () => tree.root.findAllByType(Text).map(n => [n.props.children].flat().join("")).join("\n");
const render = () => act(() => { tree = TestRenderer.create(React.createElement(SearchScreen)); });
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  useSession.setState({ session: { baseUrl: "https://example.invalid", token: "test" } });
  state = {
    tab: "all", setTab: jest.fn(), sort: "", setSort: jest.fn(), canSort: true,
    tabs: ["all", "groups", "channels", "threads", "messages"], totals: { groups: 0, channels: 0, threads: 6, messages: 1001 },
    groups: [], channels: [], threads: [thread], messages: [],
    seeAll: { groups: false, channels: false, threads: true, messages: false },
    hasMore: false, loadMore: jest.fn(), loadingMore: false, active: true, ready: true,
    isLoading: false, isError: false, error: null, refetch: jest.fn(), isRefetching: false,
  };
  (useSearchResults as jest.Mock).mockImplementation(() => state);
  (useGroups as jest.Mock).mockReturnValue({ data: fixtureGroups });
  (useMe as jest.Mock).mockReturnValue({ data: { search_ai: false } });
  (useAskAi as jest.Mock).mockReturnValue({ reset: jest.fn(), mutate: jest.fn() });
});
afterEach(() => { act(() => tree?.unmount()); jest.useRealTimers(); });

test("overview exposes counts and See all; tabs and sorting call the hook", () => {
  render();
  expect(button("All").props.accessibilityState.selected).toBe(true);
  expect(text()).toContain("1,000+");
  act(() => button("See all threads").props.onPress());
  expect(state.setTab).toHaveBeenCalledWith("threads");
  act(() => button("Messages").props.onPress());
  expect(state.setTab).toHaveBeenCalledWith("messages");
  act(() => button("Newest first").props.onPress());
  expect(state.setSort).toHaveBeenCalledWith("new");
  act(() => button("Best match").props.onPress());
  expect(state.setSort).toHaveBeenCalledWith("");
});

test("thread cards show their alias, location and reply count and navigate", () => {
  render();
  expect(text()).toContain("Release plan");
  expect(text()).toContain("#general · Product");
  expect(text()).toContain("3 replies");
  act(() => button("Open thread: Release plan").props.onPress());
  expect(router.push).toHaveBeenCalledWith({ pathname: "/(app)/thread/[channelId]/[rootId]",
    params: { channelId: "general", rootId: "42", channelName: "general", groupId: "product" } });
});

test("paged tab loads more through the hook, disables while pending and surfaces errors", () => {
  state = { ...state, tab: "threads", canSort: false, hasMore: true, seeAll: { groups: false, channels: false, threads: false, messages: false } };
  render();
  expect(button("Best match")).toBeUndefined();
  expect(button("See all threads")).toBeUndefined();
  act(() => button("More results").props.onPress());
  const error = new Error("offline");
  (state.loadMore as jest.Mock).mock.calls[0][0].onError(error);
  expect(toastErr).toHaveBeenCalledWith("Couldn't load more results", error);
  state = { ...state, loadingMore: true };
  act(() => tree.update(React.createElement(SearchScreen)));
  expect(button("More results").props.disabled).toBe(true);
});

test("tab loading does not flash an empty result and failed requests can retry", () => {
  state = { ...state, ready: false, isLoading: true, threads: [] };
  render();
  expect(text()).toContain("Searching…");
  expect(text()).not.toContain("No messages");
  state = { ...state, isLoading: false, isError: true, error: new Error("offline") };
  act(() => tree.update(React.createElement(SearchScreen)));
  expect(text()).toContain("Search failed: offline");
  act(() => button("Retry search").props.onPress());
  expect(state.refetch).toHaveBeenCalledTimes(1);
});

test("scope filtering preserves group context and applies the selected group", () => {
  render();
  act(() => button("Search scope").props.onPress());
  const find = tree.root.findAllByType(TextInput).find(n => n.props.accessibilityLabel === "Find a channel")!;
  act(() => find.props.onChangeText("responsive"));
  const section = tree.root.findByType(SectionList).props.sections[0];
  expect(section.group.name).toBe("Product");
  expect(section.data.map((c: { name: string }) => c.name)).toEqual(["responsive-web"]);
  act(() => button("All of Product").props.onPress());
  expect(useSearchResults).toHaveBeenLastCalledWith("", { groupId: "product", label: "All of Product" }, "");
  expect(tree.root.findAllByType(SectionList)).toHaveLength(0);
  act(() => button("Search scope").props.onPress());
  expect(button("All of Product").props.accessibilityState.selected).toBe(true);
});

test("typing is debounced and the overview renders the hook's four-row section", () => {
  state = { ...state, threads: Array.from({ length: 4 }, (_, i) => ({ ...thread, id: i + 1 })) };
  render();
  const input = tree.root.findAllByType(TextInput).find(n => n.props.accessibilityLabel === "Search conversations")!;
  act(() => input.props.onChangeText("release"));
  expect(useSearchResults).toHaveBeenLastCalledWith("", undefined, "");
  act(() => jest.advanceTimersByTime(250));
  expect(useSearchResults).toHaveBeenLastCalledWith("release", undefined, "");
  expect(tree.root.findByType(FlatList).props.data.filter((r: { kind: string }) => r.kind === "thread")).toHaveLength(4);
});


test("attachment filters are passed to search and clear without reopening the sheet", () => {
  render();
  act(() => button("Filter by attachment").props.onPress());
  act(() => button("Images").props.onPress());
  expect(useSearchResults).toHaveBeenLastCalledWith("", undefined, "image");
  const stopPropagation = jest.fn();
  act(() => button("Clear attachment filter").props.onPress({ stopPropagation }));
  expect(stopPropagation).toHaveBeenCalledTimes(1);
  expect(useSearchResults).toHaveBeenLastCalledWith("", undefined, "");
  expect(button("Images")).toBeUndefined();
});
