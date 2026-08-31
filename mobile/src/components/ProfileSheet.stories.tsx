import type { Meta, StoryObj } from "@storybook/react-native";
import { fn } from "storybook/test";
import {
  fixtureAgentMessage,
  fixtureAgents,
  fixtureRootMessage,
} from "@agora/core/testing/fixtures";
import { ProfileSheet } from "./ProfileSheet";

const now = Math.floor(Date.now() / 1000);
const usage = {
  usage: {
    agent_id: "codex", provider: "codex", availability: "available",
    captured_at: now - 1800,
    windows: [{ key: "primary", label: "Weekly", used_percent: 78, window_minutes: 10080, resets_at: now + 86400 }],
    plan: "pro",
  },
  refreshing: false,
  stale: true,
};

const meta = {
  title: "Native/Overlays/Profile sheet",
  component: ProfileSheet,
  args: { message: fixtureAgentMessage, onClose: fn() },
} satisfies Meta<typeof ProfileSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OnlineAgent: Story = {
  parameters: { apiRoutes: { "GET /api/agents/codex/usage": usage } },
};
export const OfflineLastKnown: Story = {
  parameters: { apiRoutes: {
    "GET /api/agents": { agents: fixtureAgents.map(agent => agent.id === "codex" ? { ...agent, live: false } : agent) },
    "GET /api/agents/codex/usage": { ...usage, stale: true },
  } },
};
export const Person: Story = {
  args: { message: fixtureRootMessage, onClose: fn() },
};
