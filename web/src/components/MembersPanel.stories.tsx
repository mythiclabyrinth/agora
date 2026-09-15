import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import {
  fixtureAgents,
  fixtureGroups,
  fixtureMe,
  fixtureMembers,
  fixtureUsers,
} from "@agora/core/testing/fixtures";
import { useUiState } from "../state/ui";
import { MembersPanel } from "./MembersPanel";

const addMember = fn(() => ({ ok: true }));
const users = [
  ...fixtureUsers,
  {
    username: "carol",
    display_name: "Carol",
    email: "carol@example.test",
    instance_role: "member",
    created_at: 1_750_000_300,
    disabled: false,
  },
  {
    username: "dave",
    display_name: "Dave",
    email: "dave@example.test",
    instance_role: "member",
    created_at: 1_750_000_310,
    disabled: false,
  },
];

const routes = {
  "GET /api/me": fixtureMe,
  "GET /api/groups": { groups: fixtureGroups },
  "GET /api/groups/product/members": { members: [
    ...fixtureMembers,
    { channel_id: "general", member_type: "user", member_id: "carol", role: "admin", added_at: 1_750_000_300, name: "Carol" },
    { channel_id: "responsive", member_type: "user", member_id: "carol", role: "member", added_at: 1_750_000_301, name: "Carol" },
  ] },
  "GET /api/agents": { agents: fixtureAgents },
  "GET /api/users": { users },
  "POST /api/groups/product/members": addMember,
};

const meta = {
  title: "Web/Connected/Members panel",
  component: MembersPanel,
  parameters: {
    apiRoutes: routes,
    setup: () => useUiState.setState({
      sel: { g: "product", c: "general" },
      membersOpen: true,
      mobileView: "main",
    }),
  },
} satisfies Meta<typeof MembersPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AdminRosterAndAdd: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("Codex", { selector: ".mname" })).resolves.toBeVisible();
    useUiState.setState({ membersOpen: false });
    const panel = canvasElement.querySelector("#agora-members-pane");
    // The store notify re-renders asynchronously — wait for the DOM to settle.
    await waitFor(() => expect(panel).toHaveStyle({ display: "none" }));
    useUiState.setState({ membersOpen: true });
    await expect(canvas.findByText("Codex", { selector: ".mname" })).resolves.toBeVisible();
    await expect(canvas.findByRole("tab", { name: "#storybook" })).resolves.toBeVisible();
    await expect(canvas.findByRole("button", { name: "＋ Add person" })).resolves.toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "＋ Add person" }));
    await expect(canvas.findByText("Pick a person")).resolves.toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: /Dave/ }));
    await expect(canvas.findByText("Add Dave", { exact: true })).resolves.toBeVisible();
    await userEvent.click(canvas.getByLabelText("Choose access"));
    await userEvent.click(canvas.getByRole("checkbox", { name: "Whole group" }));
    await userEvent.click(canvas.getByRole("button", { name: "Add" }));
    await expect(addMember).toHaveBeenCalledWith({
      member_type: "user",
      member_id: "dave",
      role: "member",
    });
  },
};

export const ChannelInlineRemove: Story = {
  parameters: {
    apiRoutes: {
      ...routes,
      "GET /api/groups/product/members": { members: [
        ...fixtureMembers,
        {
          channel_id: "general",
          member_type: "agent",
          member_id: "hermes",
          role: "member",
          added_at: 1_750_000_400,
          name: "Hermes",
        },
      ] },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("Hermes", { selector: ".mname" })).resolves.toBeVisible();
    await expect(canvas.findAllByRole("button", { name: "Remove" })).resolves.not.toHaveLength(0);
    expect([...canvasElement.querySelectorAll(".ago-scope-label")].some(el => el.textContent === "#storybook")).toBe(true);
    await userEvent.click(canvas.getByRole("tab", { name: "Whole group" }));
    await waitFor(() => {
      expect(canvasElement.querySelectorAll(".ago-scope-label")).not.toHaveLength(0);
      expect([...canvasElement.querySelectorAll(".ago-scope-label")].some(el => el.textContent === "#storybook")).toBe(true);
      expect(canvasElement.querySelector(".ago-tag-x")).not.toBeNull();
    });
  },
};

export const ShadowedChannelAccess: Story = {
  parameters: {
    apiRoutes: {
      ...routes,
      "GET /api/groups/product/members": { members: [
        {
          channel_id: null,
          member_type: "user",
          member_id: "tom",
          role: "admin",
          added_at: 1_750_000_000,
          name: "Tom",
        },
        {
          channel_id: "general",
          member_type: "user",
          member_id: "tom",
          role: "member",
          added_at: 1_750_000_010,
          name: "Tom",
        },
        {
          channel_id: null,
          member_type: "agent",
          member_id: "codex",
          role: "member",
          added_at: 1_750_000_020,
          name: "Codex",
        },
        {
          channel_id: "general",
          member_type: "agent",
          member_id: "codex",
          role: "member",
          added_at: 1_750_000_030,
          name: "Codex",
        },
      ] },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("Tom", { selector: ".mname" })).resolves.toBeVisible();
    await expect(canvas.findAllByText(/included in whole-group access/i)).resolves.not.toHaveLength(0);
    expect(canvas.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(canvas.queryByRole("button", { name: "Leave" })).toBeNull();
  },
};

export const LongChannelNames: Story = {
  parameters: {
    apiRoutes: {
      ...routes,
      "GET /api/groups": { groups: fixtureGroups.map(group => group.id === "product" ? {
        ...group,
        channels: group.channels.map((channel, index) => ({
          ...channel,
          name: index === 0 ? "customer-onboarding-and-success" : channel.name,
        })),
      } : group) },
      "GET /api/groups/product/members": { members: [
        {
          channel_id: "general",
          member_type: "agent",
          member_id: "codex",
          role: "member",
          added_at: 1_750_000_200,
          name: "Codex",
        },
      ] },
    },
    setup: () => useUiState.setState({
      sel: { g: "product", c: "general" },
      membersOpen: true,
      mobileView: "main",
    }),
  },
};

export const PopulatedRoster: Story = {
  parameters: { apiRoutes: {
    ...routes,
    "GET /api/groups/product/members": { members: [...fixtureMembers, ...["Maya Patel", "Lucas Chen", "Sofia Garcia", "Noah Wilson", "Amara Okafor", "Leo Martin", "Isla Thompson", "Arjun Mehta"].map((name, i) => ({
      channel_id: null, member_type: "user", member_id: `demo-member-${i}`, name,
      role: i === 0 ? "admin" : "member", added_at: 1_750_000_000,
    }))] },
  } },
};

export const MultiChannelAccess: Story = {
  play: async ({ canvasElement }) => {
    addMember.mockClear();
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "＋ Add person" }));
    await userEvent.click(canvas.getByRole("button", { name: /Dave/ }));
    await userEvent.click(canvas.getByLabelText("Choose access"));
    const scopes = within(canvas.getByRole("group", { name: "Access scopes" }));
    const channels = scopes.getAllByRole("checkbox").filter(el => el !== scopes.getByRole("checkbox", { name: "Whole group" }));
    await expect(channels[0]).toBeChecked();
    await userEvent.click(channels[1]);
    await userEvent.selectOptions(canvas.getByRole("combobox", { name: "Role" }), "admin");
    await userEvent.click(canvas.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(addMember).toHaveBeenCalledTimes(2));
    const expected = fixtureGroups.find(g => g.id === "product")!.channels.slice(0, 2);
    for (const channel of expected) expect(addMember).toHaveBeenCalledWith({ member_type: "user", member_id: "dave", role: "admin", channel_id: channel.id });
    await waitFor(() => expect(canvas.queryByText("Add Dave", { exact: true })).not.toBeInTheDocument());
  },
};

export const WholeGroupIsExclusive: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "＋ Add person" }));
    await userEvent.click(canvas.getByRole("button", { name: /Dave/ }));
    await userEvent.click(canvas.getByLabelText("Choose access"));
    const group = within(canvas.getByRole("group", { name: "Access scopes" }));
    const whole = group.getByRole("checkbox", { name: "Whole group" });
    const channel = group.getAllByRole("checkbox")[1];
    await userEvent.click(whole);
    await expect(channel).not.toBeChecked();
    await userEvent.click(channel);
    await expect(whole).not.toBeChecked();
    await userEvent.click(channel);
    await expect(canvas.getByRole("button", { name: "Add" })).toBeDisabled();
  },
};

const retryAdd = fn(() => ({ ok: true }));
export const RetryRemainingChannels: Story = {
  parameters: { apiRoutes: { ...routes, "POST /api/groups/product/members": retryAdd } },
  play: async ({ canvasElement }) => {
    retryAdd.mockReset();
    retryAdd.mockImplementation(() => ({ ok: true }));
    retryAdd.mockImplementationOnce(() => ({ ok: true })).mockImplementationOnce(() => { throw new Error("Connection interrupted"); });
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "＋ Add person" }));
    await userEvent.click(canvas.getByRole("button", { name: /Dave/ }));
    await userEvent.click(canvas.getByLabelText("Choose access"));
    const choices = within(canvas.getByRole("group", { name: "Access scopes" })).getAllByRole("checkbox");
    await userEvent.click(choices[2]);
    await userEvent.click(canvas.getByRole("button", { name: "Add" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Added to 1 channel");
    await expect(choices[1]).not.toBeChecked();
    await expect(choices[2]).toBeChecked();
    await userEvent.click(canvas.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(retryAdd).toHaveBeenCalledTimes(3));
    expect(retryAdd.mock.calls[2]).toEqual(retryAdd.mock.calls[1]);
    await waitFor(() => expect(canvas.queryByText("Add Dave", { exact: true })).not.toBeInTheDocument());
  },
};

export const MultiScopeRoster: Story = {
  parameters: { apiRoutes: {
    ...routes,
    "GET /api/groups": { groups: fixtureGroups.map(g => g.id === "product" ? { ...g, channels: ["general", "research", "planning", "launch"].map(id => ({ ...g.channels[0], id, name: id })) } : g) },
    "GET /api/groups/product/members": { members: [
      ...fixtureMembers.filter(m => m.member_type === "user"),
      ...["codex", "claude", "hermes"].flatMap(id => ["general", "research", "planning", "launch"].map(channel_id => ({
        member_type: "agent", member_id: id, name: id[0].toUpperCase() + id.slice(1), channel_id, role: "member", added_at: 1_750_000_000,
      }))),
    ] },
  } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("tab", { name: "Whole group" }));
    const card = canvasElement.querySelector(".ago-agent")!;
    const tags = card.querySelectorAll(".ago-scope-tag");
    expect(tags.length).toBe(4);
    expect(Math.abs(tags[0].getBoundingClientRect().top - tags[1].getBoundingClientRect().top)).toBeLessThan(2);
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
  },
};

export const AddAgentToMultipleChannels: Story = {
  play: async ({ canvasElement }) => {
    addMember.mockClear();
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "＋ Add agent" }));
    await userEvent.click(canvas.getByRole("button", { name: "Codex" }));
    expect(canvas.queryByRole("combobox", { name: "Role" })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByLabelText("Choose access"));
    const choices = within(canvas.getByRole("group", { name: "Access scopes" })).getAllByRole("checkbox");
    await userEvent.click(choices[2]);
    await userEvent.keyboard("{Escape}");
    await expect(choices[2]).not.toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(addMember).toHaveBeenCalledTimes(2));
    for (const channel of fixtureGroups.find(g => g.id === "product")!.channels.slice(0, 2)) {
      expect(addMember).toHaveBeenCalledWith({ member_type: "agent", member_id: "codex", channel_id: channel.id });
    }
  },
};
