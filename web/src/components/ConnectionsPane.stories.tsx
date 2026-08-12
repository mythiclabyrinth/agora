import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { useUiState } from "../state/ui";
import { ConnectionsPane } from "./ConnectionsPane";
import { fixtureUsers } from "@agora/core/testing/fixtures";

const meta = {
  title: "Web/Connected/Connections",
  component: ConnectionsPane,
  parameters: {
    apiRoutes: {
      "GET /api/connections": {
        instance: { id: "story-instance", name: "Storybook Agora" },
        connections: [],
      },
      "GET /api/pairing": {
        tokens: [{
          id: "pair-codex",
          token: "storybook-codex-token",
          name: "Codex",
          kind: "codex",
          created_at: 1_750_000_000,
          connected: true,
          agents: [{ id: "codex", name: "Codex" }],
        }],
      },
      "GET /api/admin/sources": { sources: [
        { kind: "pantheo", id: "Home Pantheo", name: "Home Pantheo", agents: [
          { id: "research", name: "Research", live: true, last_seen: 1_750_000_000 },
        ] },
        { kind: "pairing", id: "pair-codex", name: "Codex", agents: [
          { id: "codex", name: "Codex", live: true, last_seen: 1_750_000_000 },
        ] },
      ] },
      "GET /api/admin/agents/codex/dm-policy": { agent_id: "codex", is_public: false, grants: ["alice"] },
      "GET /api/users": { users: fixtureUsers },
      "GET /api/agents": { agents: [
        { id: "research", name: "Research", live: true, avatar: null },
        { id: "codex", name: "Codex", live: true, avatar: null },
      ] },
    },
    setup: () => useUiState.setState({ panel: "connections" }),
  },
} satisfies Meta<typeof ConnectionsPane>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ConnectedAgentAndCatalog: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("Live: Codex")).resolves.toBeVisible();
    // "Add agent" is a role="tab" in the panel's tablist, not a button.
    await userEvent.click(canvas.getByRole("tab", { name: "Add agent" }));
    await expect(canvas.findByText("What would you like to connect?")).resolves.toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: /Coding agents/ }));
    await expect(canvas.findByText("Choose a coding agent")).resolves.toBeVisible();
  },
};

export const BridgeAccessPolicy: Story = {
  play: async ({ canvasElement }) => {
    const canvas=within(canvasElement);
    await userEvent.click(await canvas.findByRole("button",{name:"Manage access"}));
    await expect(canvas.findByText("Everyone on this Agora can start a direct message")).resolves.toBeVisible();
    await expect(canvas.findByRole("switch", { name: "Public agent direct messages" })).resolves.toHaveAttribute("aria-checked", "false");
  },
};

export const HermesSetupGuide: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("tab", { name: "Add agent" }));
    await userEvent.click(await canvas.findByRole("button", { name: /Hermes/ }));
    await expect(canvas.findByRole("link", { name: "Open full setup guide" }))
      .resolves.toHaveAttribute("href", "/docs/agents/hermes.html");
    await expect(canvas.queryByText("Runs on your computer")).not.toBeInTheDocument();
  },
};
