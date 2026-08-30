import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { fixtureAgents, fixtureMe } from "@agora/core/testing/fixtures";
import { AgentProfileCard } from "./AgentProfileCard";
import { useAgentProfile } from "./MessageItem";

const now = Math.floor(Date.now() / 1000);
const usage = (provider: string, windows: object[], extra: object = {}) => ({
  usage: { agent_id: provider, provider, availability: "available", captured_at: now - 30, windows, ...extra },
  refreshing: false, stale: false,
});

const meta = {
  title: "Web/Connected/Agent profile",
  component: AgentProfileCard,
} satisfies Meta<typeof AgentProfileCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ClaudeLive: Story = {
  parameters: { apiRoutes: {
    "GET /api/me": fixtureMe,
    "GET /api/agents": { agents: fixtureAgents },
    "GET /api/agents/claude/usage": usage("claude", [
      { key: "five_hour", label: "Current session", used_percent: 34, window_minutes: 300, resets_at: now + 5400 },
      { key: "seven_day", label: "Current week", used_percent: 61, window_minutes: 10080, resets_at: now + 345600 },
    ]),
  }, setup: () => useAgentProfile.getState().show("claude") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("34% used")).resolves.toBeVisible();
    await expect(canvas.findByText("Current week")).resolves.toBeVisible();
    await userEvent.click(canvas.getByRole("button"));
    expect(useAgentProfile.getState().openId).toBeNull();
    useAgentProfile.getState().show("claude");
    await expect(canvas.findByText("34% used")).resolves.toBeVisible();
  },
};

export const CodexCreditsStale: Story = {
  parameters: { apiRoutes: {
    "GET /api/me": fixtureMe,
    "GET /api/agents": { agents: fixtureAgents },
    "GET /api/agents/codex/usage": { ...usage("codex", [
      { key: "primary", label: "Weekly", used_percent: 78, window_minutes: 10080, resets_at: now + 86400 },
    ], { plan: "pro", credits: { has_credits: true, unlimited: false, balance: "12.50" }, captured_at: now - 1800 }), stale: true },
  }, setup: () => useAgentProfile.getState().show("codex") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("78% used")).resolves.toBeVisible();
    await expect(canvas.findByText("Credit balance: 12.50")).resolves.toBeVisible();
  },
};

export const OfflineLastKnown: Story = {
  parameters: { apiRoutes: {
    "GET /api/me": fixtureMe,
    "GET /api/agents": { agents: [{ ...fixtureAgents[1], live: false }] },
    "GET /api/agents/claude/usage": usage("claude", [
      { key: "seven_day", label: "Current week", used_percent: 42, window_minutes: 10080, resets_at: now + 172800 },
    ], { captured_at: now - 7200 }),
  }, setup: () => useAgentProfile.getState().show("claude") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText(/agent offline/)).resolves.toBeVisible();
    await expect(canvas.findByText("42% used")).resolves.toBeVisible();
  },
};
