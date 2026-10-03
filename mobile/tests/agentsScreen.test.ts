import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { StyleSheet, Text } from "react-native";
import { Link, Stack } from "expo-router";
import { useAgents, useForgetAgent } from "@agora/core";
import AgentsScreen from "../app/(app)/agents";
import { useSession } from "../src/state/session";

jest.mock("@agora/core", () => ({
  ...jest.requireActual("@agora/core"),
  useAgents: jest.fn(),
  useForgetAgent: jest.fn(),
}));
jest.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  Link: ({ children }: React.PropsWithChildren) => children,
}));
jest.mock("../src/components/AgentAvatar", () => ({ AgentAvatar: () => null }));
jest.mock("lucide-react-native", () => new Proxy({}, { get: () => function MockIcon() { return null; } }));

const online = { id: "atlas", name: "Atlas", source: "pairing:example-connection", live: true, requires_mention: true, last_seen: 1, avatar: null };
const forget = jest.fn();
const refetch = jest.fn();
let tree: TestRenderer.ReactTestRenderer;

beforeEach(() => {
  jest.clearAllMocks();
  useSession.setState({ instanceAdmin: true, instanceAdminKnown: true });
  (useAgents as jest.Mock).mockReturnValue({ data: [online], isSuccess: true, refetch });
  (useForgetAgent as jest.Mock).mockReturnValue({ mutate: forget });
});
afterEach(() => act(() => tree?.unmount()));

function render() {
  act(() => { tree = TestRenderer.create(React.createElement(AgentsScreen)); });
}
function button(label: string) {
  return tree.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0];
}
function hasText(value: string) {
  return tree.root.findAllByType(Text).some((node) => node.props.children === value);
}

test("Add agent retains its route and has padded, accessible header spacing", () => {
  render();
  const options = tree.root.findByType(Stack.Screen).props.options;
  let header!: TestRenderer.ReactTestRenderer;
  act(() => { header = TestRenderer.create(options.headerRight()); });
  expect(header.root.findByType(Link).props.href).toBe("/(app)/add-agent");
  const add = header.root.findByProps({ accessibilityLabel: "Add agent" });
  expect(add.props.accessibilityLabel).toBe("Add agent");
  expect(StyleSheet.flatten(add.props.style)).toMatchObject({ minHeight: 44, paddingHorizontal: 12, gap: 8 });
  act(() => header.unmount());
});

test("members cannot see admin add controls", () => {
  useSession.setState({ instanceAdmin: false });
  render();
  expect(tree.root.findByType(Stack.Screen).props.options.headerRight).toBeUndefined();
  expect(tree.root.findAllByType(Link)).toHaveLength(0);
});

test("connection details remain available without cluttering the agent summary", () => {
  render();
  expect(hasText("Responds when mentioned")).toBe(true);
  expect(hasText(online.source)).toBe(false);
  act(() => button("Connection details for Atlas").props.onPress());
  expect(button("Connection details for Atlas").props.accessibilityState.expanded).toBe(true);
  expect(hasText(online.source)).toBe(true);
  expect(hasText(online.id)).toBe(true);
  act(() => button("Connection details for Atlas").props.onPress());
  expect(hasText(online.source)).toBe(false);
});

test("only offline agents expose Forget and it still requires confirmation", () => {
  (useAgents as jest.Mock).mockReturnValue({ data: [online, { ...online, id: "nova", name: "Nova", live: false }], isSuccess: true, refetch });
  render();
  expect(button("Forget Atlas")).toBeUndefined();
  act(() => button("Forget Nova").props.onPress());
  expect(forget).not.toHaveBeenCalled();
  act(() => button("Confirm: Forget Nova").props.onPress());
  expect(forget).toHaveBeenCalledWith("nova", expect.objectContaining({ onError: expect.any(Function) }));
});

test("failed loads provide a retry without hiding cached agents", () => {
  (useAgents as jest.Mock).mockReturnValue({ data: [online], isError: true, refetch });
  render();
  expect(hasText("Atlas")).toBe(true);
  const retry = tree.root.findAll((node) => typeof node.props.onPress === "function" && node.findAllByType(Text).some((text) => text.props.children === "Try again"))[0];
  act(() => retry.props.onPress());
  expect(refetch).toHaveBeenCalledTimes(1);
});
