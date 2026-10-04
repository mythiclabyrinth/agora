import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Alert, Text } from "react-native";
import { useAddMember, useAgents, useGroups, useMembers, useRemoveMember, useUsers, type AgentInfo, type Member, type UserInfo } from "@agora/core";
import MembersScreen, { AddAgent, AddPerson } from "../app/(app)/members/[groupId]";
import { useSession } from "../src/state/session";

let mockParams: { groupId: string; channelId?: string } = { groupId: "team" };
jest.mock("expo-router", () => ({ Stack: { Screen: () => null }, Link: ({ children }: React.PropsWithChildren) => children, useLocalSearchParams: () => mockParams }));
jest.mock("@agora/core", () => ({ ...jest.requireActual("@agora/core"), useAddMember: jest.fn(), useAgents: jest.fn(), useGroups: jest.fn(), useMembers: jest.fn(), useRemoveMember: jest.fn(), useUsers: jest.fn() }));
jest.mock("../src/components/AgentAvatar", () => ({ AgentAvatar: () => null }));
jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));
const atlas: AgentInfo = { id: "atlas", name: "Atlas", source: "", requires_mention: false, last_seen: 0, live: true, avatar: null };
const maya: UserInfo = { username: "maya", display_name: "Maya Chen", email: null, instance_role: "member", created_at: 0, disabled: false };
const channels = [{ id: "general", name: "general", role: "admin" }, { id: "design", name: "design", role: "member" }];
const member = (id: string, type: "user" | "agent", channel: string | null = null): Member => ({ member_id: id, name: id === "atlas" ? "Atlas" : "Maya Chen", member_type: type, channel_id: channel, role: "member", added_at: 0 });
const add = jest.fn(); const addAsync = jest.fn().mockResolvedValue(undefined); const remove = jest.fn(); const removeAsync = jest.fn().mockResolvedValue(undefined);
let tree: TestRenderer.ReactTestRenderer;
beforeEach(() => {
  jest.clearAllMocks(); mockParams = { groupId: "team" };
  useSession.setState({ username: "me", instanceAdmin: false });
  (useGroups as jest.Mock).mockReturnValue({ data: [{ id: "team", name: "Team", role: "admin", channels }] });
  const data = [member("maya", "user"), member("atlas", "agent")];
  (useMembers as jest.Mock).mockReturnValue({ data, isSuccess: true, refetch: jest.fn().mockResolvedValue({ data }) });
  (useAgents as jest.Mock).mockReturnValue({ data: [atlas], isSuccess: true });
  (useUsers as jest.Mock).mockReturnValue({ data: [maya], isSuccess: true });
  (useAddMember as jest.Mock).mockReturnValue({ mutate: add, mutateAsync: addAsync, isPending: false });
  (useRemoveMember as jest.Mock).mockReturnValue({ mutate: remove, mutateAsync: removeAsync });
  jest.spyOn(Alert, "alert").mockImplementation(() => {});
});
afterEach(() => { act(() => tree?.unmount()); jest.restoreAllMocks(); });
function render(element: React.ReactElement = React.createElement(MembersScreen)) { act(() => { tree = TestRenderer.create(element); }); }
function button(label: string) { return tree.root.findAll(n => n.props.accessibilityLabel === label && typeof n.props.onPress === "function")[0]; }
function label(children: React.ReactNode) { return React.Children.toArray(children).filter(c => typeof c === "string" || typeof c === "number").join(""); }
function text(value: string) { return tree.root.findAllByType(Text).some(n => label(n.props.children) === value); }
function press(label: string) { act(() => button(label).props.onPress()); }
function pressText(value: string) { const node = tree.root.findAll(n => typeof n.props.onPress === "function" && n.findAllByType(Text).some(t => label(t.props.children) === value))[0]; act(() => node.props.onPress()); }
const agentProps = { agents: [], totalAgents: 1, channels, pending: false, onAdd: add, onCancel: jest.fn() };

test("agent picker distinguishes all-added, disconnected, loading, and failed rosters", () => {
  render(React.createElement(AddAgent, agentProps));
  expect(text("All agents are already in this group")).toBe(true);
  act(() => tree.update(React.createElement(AddAgent, { ...agentProps, totalAgents: 0 })));
  expect(text("No agents connected yet")).toBe(true);
  act(() => tree.update(React.createElement(AddAgent, { ...agentProps, loading: true })));
  expect(text("All agents are already in this group")).toBe(false);
  expect(text("Loading…")).toBe(true);
  act(() => tree.update(React.createElement(AddAgent, { ...agentProps, error: true })));
  expect(text("All agents are already in this group")).toBe(false);
  expect(text("Couldn't load the available members.")).toBe(true);
});
test("channel picker explains when all agents already have access", () => {
  render(React.createElement(AddAgent, { ...agentProps, channelFocused: true }));
  expect(text("All agents are already in this channel")).toBe(true);
});
test("agent multiselect skips existing channel grants", async () => {
  render(React.createElement(AddAgent, { ...agentProps, agents: [atlas], memberships: [member("atlas", "agent", "general")] }));
  press("Select Atlas"); press("Continue to access"); press("Selected channels"); press("Select channels");
  press("Select #general"); press("Select #design"); press("Done selecting channels");
  await act(async () => button("Add selected participants").props.onPress());
  expect(add).toHaveBeenCalledTimes(1); expect(add).toHaveBeenCalledWith(atlas, "design");
});
test("person picker retains scope and role selection", async () => {
  render(React.createElement(AddPerson, { users: [maya], channels, pending: false, onAdd: add, onCancel: jest.fn() }));
  press("Select Maya Chen"); press("Continue to access"); press("Selected channels"); press("Select channels"); press("Select #design"); press("Done selecting channels");
  press("Role for #design: member"); pressText("Admin");
  await act(async () => button("Add selected participants").props.onPress());
  expect(add).toHaveBeenCalledWith(maya, "admin", "design");
  expect(button("Close set access")).toBeDefined();
});
test("people show meaningful access, search works, and tabs switch the roster", () => {
  render(); expect(text("Group member")).toBe(true); expect(text("1 access level")).toBe(false);
  const search = tree.root.findAll(n => n.props.accessibilityLabel === "Search participants" && typeof n.props.onChangeText === "function")[0];
  act(() => search.props.onChangeText("missing")); expect(text("No matching participants")).toBe(true);
  act(() => search.props.onChangeText("")); press("Agents"); expect(text("All channels")).toBe(true);
  expect(button("Remove Atlas from Whole group")).toBeUndefined();
});
test("agent removal lives in details and requires confirmation", () => {
  render(); press("Agents"); press("Access for Atlas"); press("Remove Atlas from Whole group");
  expect(remove).not.toHaveBeenCalled();
  const actions = (Alert.alert as jest.Mock).mock.calls.at(-1)[2];
  act(() => actions.find((a: { text: string }) => a.text === "Remove").onPress());
  expect(remove).toHaveBeenCalledWith({ member_type: "agent", member_id: "atlas", channel_id: null }, expect.anything());
});
test("permissions fail closed until the group loads", () => {
  (useGroups as jest.Mock).mockReturnValue({ data: undefined }); render();
  expect(button("Add people")).toBeUndefined(); press("Agents"); expect(button("Add agents")).toBeUndefined();
  press("Access for Atlas"); expect(button("Remove Atlas from Whole group")).toBeUndefined();
});
test("channel admin cannot remove inherited group access but can remove exact channel access", () => {
  mockParams = { groupId: "team", channelId: "general" };
  (useGroups as jest.Mock).mockReturnValue({ data: [{ id: "team", role: "member", channels }] });
  render(); press("Agents"); press("Access for Atlas"); expect(button("Remove Atlas from Whole group")).toBeUndefined();
  press("Close participant access");
  (useMembers as jest.Mock).mockReturnValue({ data: [member("atlas", "agent", "general")], isSuccess: true });
  act(() => tree.update(React.createElement(MembersScreen))); press("Access for Atlas"); press("Remove Atlas from #general");
  expect(Alert.alert).toHaveBeenCalled();
});
test("person role updates are staged until saved and keep their exact scope", async () => {
  render(); press("Access for Maya Chen"); press("Group role: member"); pressText("Admin");
  expect(addAsync).not.toHaveBeenCalled();
  await act(async () => button("Save access changes").props.onPress());
  expect(addAsync).toHaveBeenCalledWith({ member_type: "user", member_id: "maya", role: "admin", channel_id: undefined });
});
test("self can leave an exact channel without group management permission", () => {
  mockParams = { groupId: "team", channelId: "design" }; useSession.setState({ username: "maya" });
  (useGroups as jest.Mock).mockReturnValue({ data: [{ id: "team", name: "Team", role: "member", channels }] });
  (useMembers as jest.Mock).mockReturnValue({ data: [member("maya", "user", "design")], isSuccess: true });
  render(); press("Access for Maya Chen, you"); press("Leave #design"); expect(Alert.alert).toHaveBeenCalled();
  expect(button("Role for #design: member").props.disabled).toBe(true);
});

test("group admin entering via a channel can edit inherited whole-group access", () => {
  mockParams.channelId = "general"; render(); press("Access for Maya Chen");
  expect(button("Group role: member").props.disabled).toBe(false);
  expect(button("Selected channels")).toBeDefined();
});
test("channel admin entering via group sees the same editor, limited to administered channels", () => {
  (useGroups as jest.Mock).mockReturnValue({ data: [{ id: "team", role: "member", channels }] });
  (useMembers as jest.Mock).mockReturnValue({ data: [member("maya", "user", "general"), member("maya", "user", "design")], isSuccess: true });
  render(); expect(button("Add people")).toBeDefined(); press("Access for Maya Chen");
  expect(button("Role for #general: member").props.disabled).toBe(false);
  expect(button("Role for #design: member").props.disabled).toBe(true);
  expect(button("Entire group")).toBeUndefined(); press("Select channels");
  expect(button("Select #general")).toBeDefined(); expect(button("Select #design")).toBeUndefined();
});
test("channel admin cannot edit inherited whole-group roles", () => {
  (useGroups as jest.Mock).mockReturnValue({ data: [{ id: "team", role: "member", channels }] });
  render(); press("Access for Maya Chen");
  expect(button("Group role: member").props.disabled).toBe(true);
  expect(button("Save access changes")).toBeUndefined();
});
test("group admin sees other channel roles even when opened from one channel", () => {
  mockParams.channelId = "general";
  (useMembers as jest.Mock).mockReturnValue({ data: [member("maya", "user", "general"), { ...member("maya", "user", "design"), role: "admin" }], isSuccess: true });
  render(); press("Access for Maya Chen");
  expect(button("Role for #design: admin").props.disabled).toBe(false);
});
test("batch addition supports multiple people and retries only unfinished grants", async () => {
  const lee = { ...maya, username: "lee", display_name: "Lee" };
  const batch = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Offline")).mockResolvedValue(undefined);
  const close = jest.fn();
  render(React.createElement(AddPerson, { users: [maya, lee], channels, pending: false, onAdd: batch, onCancel: close }));
  press("Select Maya Chen"); press("Select Lee"); press("Continue to access");
  await act(async () => button("Add selected participants").props.onPress());
  expect(close).not.toHaveBeenCalled(); expect(batch).toHaveBeenCalledTimes(2);
  await act(async () => button("Add selected participants").props.onPress());
  expect(batch).toHaveBeenCalledTimes(3); expect(batch.mock.calls[2][0].username).toBe("lee"); expect(close).toHaveBeenCalledTimes(1);
});
test("stale access is not overwritten", async () => {
  (useMembers as jest.Mock).mockReturnValue({ data: [member("maya", "user")], isSuccess: true,
    refetch: jest.fn().mockResolvedValue({ data: [{ ...member("maya", "user"), role: "admin" }] }) });
  render(); press("Access for Maya Chen"); press("Group role: member"); pressText("Admin");
  await act(async () => button("Save access changes").props.onPress());
  expect(addAsync).not.toHaveBeenCalled(); expect(button("Save access changes").props.disabled).toBe(true);
});
