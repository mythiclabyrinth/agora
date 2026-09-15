import type { Meta, StoryObj } from "@storybook/react-vite";
import { fixtureMe } from "@agora/core/testing/fixtures";
import { AgentDmPanel } from "./AgentDmPanel";
import { expect, within } from "storybook/test";

const dms = {
  conversations: [{ channel_id: "dm-codex", agent_id: "codex", agent_name: "Codex", last_seen: 1, unread: 0 }],
  agents: [
    { id: "codex", name: "Codex", live: true, can_dm: true, is_public: true },
    { id: "claude", name: "Claude", live: false, can_dm: true, is_public: false },
  ],
};

const meta = {
  title: "Web/Connected/Agent direct messages",
  component: AgentDmPanel,
  args: { onClose: () => undefined },
  parameters: { apiRoutes: {
    "GET /api/me": fixtureMe,
    "GET /api/agents": { agents: [
      { id: "codex", name: "Codex", live: true, avatar: null },
      { id: "claude", name: "Claude", live: false, avatar: null },
    ] },
    "GET /api/dms": dms,
  } },
} satisfies Meta<typeof AgentDmPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const EligibleAgents: Story = { play: async ({canvasElement}) => {
  const canvas=within(canvasElement.ownerDocument.body);
  await expect(canvas.findByRole("dialog")).resolves.toHaveAttribute("aria-modal","true");
  await expect(canvas.findByText("Claude")).resolves.toBeVisible();
  await expect(canvas.findByText("Claude")).resolves.toHaveClass("ago-dm-agent-name");
  expect(canvas.getByRole("button", { name: /Claude/ }).querySelector(".ago-av")).toBeTruthy();
  expect(canvas.queryByText("Codex")).not.toBeInTheDocument();
} };

export const NoNewAgents: Story = {
  parameters: { apiRoutes: { "GET /api/dms": { conversations: dms.agents.map(agent => ({
    channel_id: `dm-${agent.id}`, agent_id: agent.id, agent_name: agent.name, last_seen: 1, unread: 0,
  })), agents: dms.agents } } },
  play: async ({canvasElement}) => {
    await expect(within(canvasElement.ownerDocument.body).findByText("No new agents are available to message.")).resolves.toBeVisible();
  },
};

export const PopulatedAgents: Story = {
  parameters: { apiRoutes: {
    "GET /api/dms": { conversations: [], agents: ["Research assistant", "Code reviewer", "Design partner", "Project planner", "Writing assistant", "Data analyst", "Support assistant", "Release coordinator"].map((name, i) => ({
      id: `demo-agent-${i}`, name, live: i % 3 !== 0, can_dm: true, is_public: i % 2 === 0,
    })) },
  } },
};
