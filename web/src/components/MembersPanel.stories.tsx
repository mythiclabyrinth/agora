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
    await expect(canvas.findByText(/Where should Dave have access/)).resolves.toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Whole group" }));
    await userEvent.click(canvas.getByRole("button", { name: /^Member/ }));
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
    await expect(canvas.queryByText("#storybook · admin")).toBeNull();
    await userEvent.click(canvas.getByRole("tab", { name: "Whole group" }));
    await waitFor(() => {
      expect(canvasElement.querySelectorAll(".ago-scope-label")).not.toHaveLength(0);
      expect([...canvasElement.querySelectorAll(".ago-scope-label")].some(el => el.textContent === "#storybook")).toBe(true);
      expect(canvasElement.querySelector(".ago-tag-x")).not.toBeNull();
    });
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
