import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Modal, ScrollView, StyleSheet } from "react-native";
import * as Clipboard from "expo-clipboard";
import { ProfileSheet } from "../src/components/ProfileSheet";
import { AppThemeContext } from "../src/lib/useTheme";
import { themes } from "../src/lib/theme";
import type { Message } from "@agora/core";

jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));
jest.mock("../src/components/AgentAvatar", () => ({ AgentAvatar: "AgentAvatar" }));
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../src/components/Toast", () => ({ toast: jest.fn(), toastErr: jest.fn() }));
const mockRefetch = jest.fn();
let mockAgent: Record<string, unknown> | null;
let mockUser: Record<string, unknown> | null;
let mockError = false;
let mockUsage: unknown;
jest.mock("@agora/core", () => ({
  ...jest.requireActual("@agora/core"),
  useAgents: () => ({ data: mockAgent ? [mockAgent] : [], isError: mockError, refetch: mockRefetch }),
  useUsers: () => ({ data: mockUser ? [mockUser] : [], isError: mockError, refetch: mockRefetch }),
  useAgentUsage: () => ({ data: mockUsage, dataUpdatedAt: Date.now() }),
}));
const source = "pairing:f6d34bb40217625d3c8a79557604a626";
const message = { id: 1, channel_id: "c", thread_id: null, author_type: "agent", author_id: "atlas", author_name: "Atlas", text: "", ts: 1, attachments: [] } satisfies Message;
beforeEach(() => {
  mockAgent = { id: "atlas", name: "Atlas", live: true, requires_mention: true, source, last_seen: 1700000000 };
  mockUser = null; mockError = false; mockUsage = undefined; jest.clearAllMocks();
});
function render(mode: "light" | "dark", author: Message = message) {
  let tree!: TestRenderer.ReactTestRenderer;
  const onClose = jest.fn();
  act(() => { tree = TestRenderer.create(React.createElement(AppThemeContext.Provider, { value: themes[mode] },
    React.createElement(ProfileSheet, { message: author, onClose }))); });
  return { tree, onClose };
}
function hasText(tree: TestRenderer.ReactTestRenderer, text: string) {
  return tree.root.findAll(node => node.props.children === text).length > 0;
}
test.each(["light", "dark"] as const)("agent profile preserves readable complete details and copy in %s", async mode => {
  const { tree, onClose } = render(mode);
  expect(hasText(tree, "Online")).toBe(true);
  expect(hasText(tree, "When mentioned")).toBe(true);
  const value = tree.root.findAll(node => node.props.children === source && node.props.selectable)[0];
  expect(value.props.numberOfLines).toBeUndefined();
  expect(StyleSheet.flatten(value.props.style).color).toBe(themes[mode].colors.text);
  expect(tree.root.findByType(ScrollView)).toBeTruthy();
  await act(async () => { await tree.root.findAllByProps({ accessibilityLabel: "Copy connection" })[0].props.onPress(); });
  expect(Clipboard.setStringAsync).toHaveBeenCalledWith(source);
  act(() => tree.root.findByType(Modal).props.onRequestClose());
  expect(onClose).toHaveBeenCalledTimes(1);
  act(() => tree.unmount());
});
test("person profile keeps account role, email and join date", async () => {
  mockUser = { username: "devon", display_name: "Devon Park", instance_role: "member", email: "devon@northwind.dev", created_at: 1700000000 };
  const { tree } = render("light", { ...message, author_type: "user", author_id: "devon" });
  expect(hasText(tree, "Devon Park")).toBe(true);
  expect(hasText(tree, "Workspace member")).toBe(true);
  expect(hasText(tree, "Joined")).toBe(true);
  await act(async () => { await tree.root.findAllByProps({ accessibilityLabel: "Copy email" })[0].props.onPress(); });
  expect(Clipboard.setStringAsync).toHaveBeenCalledWith("devon@northwind.dev");
  act(() => tree.unmount());
});
test("offline agents retain last seen and usage", () => {
  mockAgent!.live = false;
  mockUsage = { usage: { captured_at: 1700000000, windows: [{ key: "week", label: "Weekly", used_percent: 78 }] }, stale: true };
  const { tree } = render("dark");
  expect(hasText(tree, "Offline")).toBe(true);
  expect(hasText(tree, "Last seen")).toBe(true);
  expect(hasText(tree, "Weekly")).toBe(true);
  act(() => tree.unmount());
});
test("missing profile details can be retried without losing the author's identity", () => {
  mockAgent = null; mockError = true;
  const { tree } = render("light");
  expect(hasText(tree, "Atlas")).toBe(true);
  act(() => tree.root.findAllByProps({ accessibilityLabel: "Retry profile" })[0].props.onPress());
  expect(mockRefetch).toHaveBeenCalledTimes(1);
  act(() => tree.unmount());
});
