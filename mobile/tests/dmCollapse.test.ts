import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Modal, Text } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiClient, ApiProvider, keys, type Group, type Channel } from "@agora/core";
import { DmGroupCard, GroupCard, UnreadBadge } from "../app/(app)/index";
import { usePrefs } from "../src/state/prefs";
import { useSession } from "../src/state/session";

const mockRead = jest.fn();
const mockWrite = jest.fn().mockResolvedValue(undefined);
jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///test/",
  readAsStringAsync: (...args: unknown[]) => mockRead(...args),
  writeAsStringAsync: (...args: unknown[]) => mockWrite(...args),
}));
jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));
jest.mock("expo-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
  Stack: { Screen: () => null }, router: { push: jest.fn() }, useLocalSearchParams: () => ({}),
}));

const channel = (id: string, unread = 0, mentions = 0, hidden = false): Channel => ({
  id, group_id: "__dms", name: id, unread, mentions, hidden, topic: "", created_at: 0,
});
const group: Group = {
  id: "__dms", name: "Direct messages", description: "", created_by: null,
  created_at: 0, role: "member", kind: "agent_dms",
  channels: [channel("Atlas", 4), channel("Nova", 0, 2), channel("Scribe"), channel("Hidden", 20, 10, true)],
};
let tree: TestRenderer.ReactTestRenderer;
let client: QueryClient;
beforeEach(() => {
  jest.clearAllMocks();
  usePrefs.setState({ loaded: true, collapsedGroups: {} });
  useSession.setState({ username: "alex", session: { baseUrl: "https://agora.example", token: "test" } });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(keys.dms, { conversations: [], agents: [] });
  client.setQueryData(keys.agents, []);
});
afterEach(() => { act(() => tree?.unmount()); client.clear(); });
function render(data = group, unreadsOnly = false, component: React.ComponentType<{ group: Group; unreadsOnly: boolean }> = DmGroupCard) {
  act(() => {
    tree = TestRenderer.create(React.createElement(QueryClientProvider, { client },
      React.createElement(ApiProvider, { client: new ApiClient({ baseUrl: "https://agora.example", token: "test" }) },
        React.createElement(component, { group: data, unreadsOnly }))));
  });
}
function button(label: string) {
  return tree.root.findAll(n => n.props.accessibilityLabel === label && typeof n.props.onPress === "function")[0];
}
function text(value: string) {
  return tree.root.findAllByType(Text).some(n => n.props.children === value);
}

test("DMs collapse, persist through reload, and expand again", async () => {
  render();
  expect(text("Atlas")).toBe(true);
  act(() => button("Direct messages").props.onPress());
  expect(button("Direct messages").props.accessibilityState.expanded).toBe(false);
  expect(text("Atlas")).toBe(false);
  const saved = mockWrite.mock.calls.at(-1)![1];
  expect(JSON.parse(saved).collapsedGroups).toHaveLength(1);
  act(() => usePrefs.setState({ collapsedGroups: {} }));
  mockRead.mockResolvedValue(saved);
  await act(async () => { await usePrefs.getState().load(); });
  expect(text("Atlas")).toBe(false);
  act(() => button("Direct messages").props.onPress());
  expect(text("Atlas")).toBe(true);
});

test("collapsed badge aggregates visible unreads and mentions and new DM stays reachable", () => {
  render();
  act(() => button("Direct messages").props.onPress());
  expect(tree.root.findByType(UnreadBadge).props).toMatchObject({ count: 4, mentions: 2 });
  act(() => button("Start a direct message with an agent").props.onPress());
  expect(tree.root.findByType(Modal).props.visible).toBe(true);
  expect(button("Direct messages").props.accessibilityState.expanded).toBe(false);
});

test("collapse is isolated by account and server", () => {
  render();
  act(() => button("Direct messages").props.onPress());
  act(() => useSession.setState({ username: "maya" }));
  expect(text("Atlas")).toBe(true);
  act(() => useSession.setState({ username: "alex", session: { baseUrl: "https://other.example", token: "test" } }));
  expect(text("Atlas")).toBe(true);
  act(() => useSession.setState({ session: { baseUrl: "https://agora.example", token: "test" } }));
  expect(text("Atlas")).toBe(false);
});

test("unread-only includes mentions, excludes read and hidden DMs", () => {
  render(group, true);
  expect(text("Atlas")).toBe(true);
  expect(text("Nova")).toBe(true);
  expect(text("Scribe")).toBe(false);
  expect(text("Hidden")).toBe(false);
});

test("filtered-empty DMs explain why the list is empty", () => {
  render({ ...group, channels: [channel("Scribe")] }, true);
  expect(text("No unread direct messages")).toBe(true);
  act(() => button("Direct messages").props.onPress());
  expect(text("No unread direct messages")).toBe(false);
});

test("group create control is separate from collapse control", () => {
  render({ ...group, id: "product", kind: undefined }, false, GroupCard);
  const create = button("Create channel in Direct messages");
  expect(create.parent?.props.onPress).toBeUndefined();
  act(() => create.props.onPress());
  expect(usePrefs.getState().collapsedGroups).toEqual({});
  expect(tree.root.findAll(n => n.props.placeholder === "new channel name").length).toBeGreaterThan(0);
});


test.each([1, 2])("all-hidden groups describe their %i hidden channels in the count", count => {
  render({ ...group, id: "leadership", kind: undefined,
    channels: Array.from({ length: count }, (_, i) => channel(`hidden-${i}`, 0, 0, true)),
  }, false, GroupCard);
  expect(text(`${count} hidden ${count === 1 ? "channel" : "channels"}`)).toBe(true);
  expect(text("0 channels")).toBe(false);
  expect(text("All channels are hidden.")).toBe(true);
});
