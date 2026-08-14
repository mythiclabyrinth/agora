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
    await expect(canvas.findByText("Codex")).resolves.toBeVisible();
    useUiState.setState({ membersOpen: false });
    const panel = canvasElement.querySelector("#agora-members-pane");
    // The store notify re-renders asynchronously — wait for the DOM to settle.
    await waitFor(() => expect(panel).toHaveStyle({ display: "none" }));
    useUiState.setState({ membersOpen: true });
    // "Codex" also appears as an <option> in the add-agent select.
    await expect(canvas.findByText("Codex", { selector: ".mname" })).resolves.toBeVisible();
    await expect(canvas.findByText("Carol", { selector: ".mname" })).resolves.toBeVisible();
    await expect(canvas.findByText("#storybook · admin")).resolves.toBeVisible();
    const person = canvasElement.querySelector<HTMLSelectElement>("#ago-add-user");
    if (!person) throw new Error("Missing add-person picker");
    await userEvent.selectOptions(person, "carol");
    await userEvent.click(canvas.getByRole("button", { name: "Add person" }));
    await expect(addMember).toHaveBeenCalledWith({
      member_type: "user",
      member_id: "carol",
      role: "member",
    });
  },
};
