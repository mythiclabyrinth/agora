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
          name: "workstation-connection",
          kind: "codex",
          created_at: 1_750_000_000,
          connected: true,
          agents: [{ id: "codex", name: "Codex M5" }],
        }],
      },
      "GET /api/admin/sources": { sources: [
        { kind: "pantheo", id: "Home Pantheo", name: "Home Pantheo", agents: [
          { id: "research", name: "Research", live: true, last_seen: 1_750_000_000 },
        ] },
        { kind: "pairing", id: "pair-codex", name: "workstation-connection", agents: [
          { id: "codex", name: "Codex M5", live: true, last_seen: 1_750_000_000 },
        ] },
      ] },
      "GET /api/admin/agents/codex/dm-policy": { agent_id: "codex", is_public: false, grants: ["alice"] },
      "GET /api/users": { users: fixtureUsers },
      "GET /api/agents": { agents: [
        { id: "research", name: "Research", live: true, avatar: null },
        { id: "codex", name: "Codex M5", live: true, avatar: null },
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
    await expect(canvas.findByRole("button", { name: /Codex.*View profile/ })).resolves.toBeVisible();
    // "Add agent" is a role="tab" in the panel's tablist, not a button.
    await userEvent.click(canvas.getByRole("tab", { name: "Add agent" }));
    await expect(canvas.findByText("What would you like to connect?")).resolves.toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: /Coding agents/ }));
    await expect(canvas.findByText("Choose a coding agent")).resolves.toBeVisible();
  },
};

export const UnifiedAgentManagement: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByRole("button", { name: /Codex.*View profile/ })).resolves.toBeVisible();
    expect(canvas.queryByText("Live: Codex")).not.toBeInTheDocument();
    const source = canvasElement.querySelector(".agent-source-card")!;
    expect(source.querySelectorAll(".ago-av")).toHaveLength(1);
    expect(source.querySelectorAll(".conn-dot")).toHaveLength(0);
    expect(within(source as HTMLElement).getAllByText("Online")).toHaveLength(1);
    expect(canvas.getAllByText("Codex", { exact: true })).toHaveLength(1);
    expect(canvas.getAllByText("Codex M5", { exact: true })).toHaveLength(1);
    expect(canvas.getAllByText("@codex", { exact: true })).toHaveLength(1);
    expect(canvas.queryByText("workstation-connection")).not.toBeInTheDocument();
    expect(canvas.queryByLabelText("Masked access key")).not.toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "Copy key" })).toBeVisible();
    expect(canvas.queryByRole("tab", { name: "Connections" })).not.toBeInTheDocument();
    expect(canvas.queryByText("This Agora")).not.toBeInTheDocument();
    expect(canvas.getByRole("button", { name: /Codex.*View profile/ })).toBeVisible();
    expect(canvas.getByRole("button", { name: "Manage access" })).toBeVisible();
    const search = canvas.getByRole("searchbox", { name: "Search agents" });
    await userEvent.type(search, "missing-agent");
    expect(canvas.getByText("No matching agents or integrations.")).toBeVisible();
    await userEvent.clear(search);
    expect(canvas.getByRole("button", { name: "Manage access" })).toBeVisible();
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

export const OpenClawSetupGuide: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("tab", { name: "Add agent" }));
    await userEvent.click(await canvas.findByRole("button", { name: /OpenClaw/ }));
    await expect(canvas.findByRole("link", { name: "Open full setup guide" }))
      .resolves.toHaveAttribute("href", "/docs/agents/openclaw.html");
    await expect(canvas.queryByText("Runs on your computer")).not.toBeInTheDocument();
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

const integrationAgents = [
  { id: "hermes-research", name: "Research partner", live: true },
  { id: "claw-atlas", name: "Atlas", live: true },
  { id: "claw-nova", name: "Nova", live: false },
];

export const HermesAndSharedOpenClaw: Story = {
  parameters: { apiRoutes: {
    ...meta.parameters.apiRoutes,
    "GET /api/pairing": { tokens: [
      { id: "pair-hermes", token: "test-hermes-key", name: "hermes-host", kind: "hermes", connected: true, agents: integrationAgents.slice(0, 1) },
      { id: "pair-claw", token: "test-claw-key", name: "Team service", kind: "claw", connected: true, agents: integrationAgents.slice(1) },
      { id: "pair-pending", token: "test-pending-key", name: "New workstation", kind: "cursor", connected: false, agents: [] },
    ] },
    "GET /api/agents": { agents: integrationAgents },
    "GET /api/admin/sources": { sources: [
      { kind: "pairing", id: "pair-hermes", name: "hermes-host", agents: integrationAgents.slice(0, 1) },
      { kind: "pairing", id: "pair-claw", name: "Team service", agents: integrationAgents.slice(1) },
      { kind: "pairing", id: "pair-pending", name: "New workstation", agents: [] },
    ] },
    "GET /api/admin/agents/claw-nova/dm-policy": { agent_id: "claw-nova", is_public: false, grants: [] },
  } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const hermes = await canvas.findByRole("button", { name: /Hermes.*Research partner.*@hermes-research.*Online.*View profile/ });
    expect(hermes.querySelectorAll(".ago-av")).toHaveLength(1);
    expect(canvas.queryByText("hermes-host")).not.toBeInTheDocument();
    const atlas = canvas.getByRole("button", { name: /OpenClaw.*Atlas.*Online.*View profile/ });
    expect(canvas.getByRole("button", { name: /OpenClaw.*Nova.*Offline.*View profile/ })).toBeVisible();
    expect(canvas.getByText("2 agents · shared access")).toBeVisible();
    const pending = canvas.getByText("New workstation").closest("article")!;
    expect(within(pending).getByRole("button", { name: "Copy key" })).toBeVisible();
    expect(within(pending).getByRole("button", { name: "Revoke" })).toBeVisible();
    await userEvent.click(within(atlas.closest("article")!).getByRole("button", { name: "Manage access" }));
    await expect(canvas.findByText("Choose an agent to manage who can start a direct message.")).resolves.toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: /Nova/ }));
    await expect(canvas.findByRole("switch", { name: "Public agent direct messages" })).resolves.toHaveAttribute("aria-checked", "false");
  },
};

export const PopulatedConnections: Story = {
  parameters: { apiRoutes: {
    ...meta.parameters.apiRoutes,
    "GET /api/pairing": { tokens: ["Codex workstation", "Claude research", "Hermes assistant", "Cursor laptop", "Release helper", "Weekend researcher"].map((name, i) => ({
      id: `demo-pair-${i}`, token: `demo-only-token-${i}`, name, kind: ["codex", "claude", "hermes", "cursor"][i % 4],
      created_at: 1_750_000_000, connected: i < 4,
      agents: [{ id: `demo-agent-${i}`, name }],
    })) },
  } },
};
