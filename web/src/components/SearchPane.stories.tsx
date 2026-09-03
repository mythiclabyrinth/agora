import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import {
  fixtureAgentMessage,
  fixtureGroups,
  fixtureMe,
} from "@agora/core/testing/fixtures";
import { useUiState } from "../state/ui";
import { SearchPane } from "./SearchPane";

const hit = {
  ...fixtureAgentMessage,
  channel_name: "storybook",
  group_id: "product",
  group_name: "Product",
  // Keep a file card in the search fixture so its shared structure stays covered.
  attachments: [
    { id: "spec", filename: "search-result-spec.pdf", mime: "application/pdf", size: 262_144 },
  ],
  snippet: "The real panes use \u0001fixture\u0002 data.",
};

const routes = {
  "GET /api/me": fixtureMe,
  "GET /api/groups": { groups: fixtureGroups },
  "GET /api/search?q=fixture": {
    query: "fixture",
    groups: [{ id: "product", name: "Product", description: "Product planning", hidden: false }],
    channels: [{
      id: "general",
      group_id: "product",
      name: "storybook",
      topic: "Component development",
      hidden: false,
      group_name: "Product",
    }],
    messages: { items: [hit], has_more: false, offset: 0 },
  },
};

const dmHit = {
  ...hit,
  id: 10900,
  thread_id: 10897,
  channel_id: "claude-m5-5b85",
  channel_name: "Claude M5",
  group_id: "__dms",
  group_name: "Direct messages",
  text: "Private fixture result",
  snippet: "Private \u0001fixture\u0002 result",
  attachments: [],
};

const dmGroup = {
  id: "__dms",
  name: "Direct messages",
  description: "Private conversations with agents",
  created_by: null,
  created_at: 0,
  role: "member" as const,
  is_public: false,
  kind: "agent_dms",
  channels: [{
    id: "claude-m5-5b85",
    group_id: "",
    name: "Claude M5",
    topic: "",
    created_at: 0,
    unread: 0,
    mentions: 0,
  }],
};

const meta = {
  title: "Web/Connected/Search",
  component: SearchPane,
  parameters: {
    apiRoutes: routes,
    setup: () => useUiState.setState({ searchOpen: true }),
  },
} satisfies Meta<typeof SearchPane>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ResultsAndKeyboardNavigation: Story = {
  parameters: {
    docs: { description: { story: "Searches fixture-backed groups, channels, and messages. Escape-close is tested mid-run, then results are reopened for inspection." } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = await canvas.findByPlaceholderText("Search messages, channels, groups…");
    await userEvent.type(input, "fixture");
    await expect(canvas.findByText("Product planning")).resolves.toBeVisible();
    await expect(canvas.findByText("fixture")).resolves.toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(useUiState.getState().searchOpen).toBe(false);
    useUiState.getState().setSearchOpen(true);
    const reopened = await canvas.findByPlaceholderText("Search messages, channels, groups…");
    // The pane keeps its query across close/reopen — clear it or the retype
    // appends and queries a route the fixtures don't define.
    await userEvent.clear(reopened);
    await userEvent.type(reopened, "fixture");
    await expect(canvas.findByText("Product planning")).resolves.toBeVisible();
    const filename = await canvas.findByText("search-result-spec.pdf");
    expect(filename).toBeVisible();
    await expect(canvas.findByText("256.0 KB")).resolves.toBeVisible();
    expect(filename.closest(".ago-file-meta")).not.toBeNull();
    const card = filename.closest(".ago-att-file");
    expect(card).not.toBeNull();
    expect(card?.querySelector(".ago-file-icon")).not.toBeNull();
  },
};

export const AgentDirectMessageResult: Story = {
  parameters: {
    apiRoutes: {
      "GET /api/me": fixtureMe,
      "GET /api/groups": { groups: [...fixtureGroups, dmGroup] },
      "GET /api/search?q=fixture&group_id=__dms": {
        query: "fixture",
        groups: [],
        channels: [],
        messages: { items: [dmHit], has_more: false, offset: 0 },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(await canvas.findByTitle("Search scope"), "g:__dms");
    await userEvent.type(canvas.getByPlaceholderText("Search messages, channels, groups…"), "fixture");
    const crumb = await canvas.findByText("Direct messages / #Claude M5 · in thread");
    await userEvent.click(crumb.closest(".ago-search-row.msg") as HTMLElement);
    expect(useUiState.getState().sel).toEqual({ g: "__dms", c: "claude-m5-5b85" });
    expect(useUiState.getState().threadRoot).toBe(10897);
    expect(window.location.pathname).toMatch(/\/g\/__dms\/c\/claude-m5-5b85\/t\/10897$/);
  },
};
