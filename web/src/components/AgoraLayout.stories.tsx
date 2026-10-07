import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import {
  fixtureAgents,
  fixtureChannelAgents,
  fixtureGroups,
  fixtureMe,
  fixtureMembers,
  fixtureMessages,
  fixtureReplies,
  fixtureTemplates,
  fixtureThreads,
  fixtureUsers,
} from "@agora/core/testing/fixtures";
import { useUiState } from "../state/ui";
import { AgoraLayout } from "./AgoraLayout";

// An empty username keeps useAgoraSocket dormant in this full-layout story.
// Mine/self presentation states are covered by the focused component stories.
const staticMe = { ...fixtureMe, username: "" };
const markRead = fn(() => ({ ok: true, last_read_id: 43 }));
const attachmentPage = {
  items: [{
    id: "launch-plan", filename: "launch-plan.pdf", mime: "application/pdf", size: 524_288,
    channel_id: "general", message_id: 43, thread_id: 42, author_type: "user", author_id: "tom",
    author_name: "Tom", message_text: "The 820px phone boundary is covered.", ts: 1_750_000_000,
    thread_name: "Responsive review", can_delete: false,
  }],
  has_more: false,
  offset: 0,
};
const routes = {
  "GET /api/me": staticMe,
  "GET /api/groups": { groups: fixtureGroups },
  "GET /api/threads?limit=100": { threads: fixtureThreads },
  "GET /api/unreads": { items: [] },
  "GET /api/agents": { agents: fixtureAgents },
  "GET /api/users": { users: fixtureUsers },
  "GET /api/groups/product/members": { members: fixtureMembers },
  "GET /api/groups/product/templates": { templates: fixtureTemplates },
  "GET /api/channels/general/agents": { agents: fixtureChannelAgents },
  "GET /api/channels/general/activity": { typing: [], progress: [] },
  "GET /api/activity": { channels: {} },
  "GET /api/channels/general/messages?limit=50": { messages: fixtureMessages },
  "GET /api/channels/general/messages?limit=50&thread_id=42": { messages: fixtureReplies },
  "GET /api/messages/42": fixtureMessages[0],
  "GET /api/channels/general/pins": { pins: [] },
  "GET /api/channels/general/stars": { stars: [] },
  "GET /api/channels/general/attachments?offset=0": attachmentPage,
  "GET /api/channels/general/attachments?offset=0&thread_id=42": attachmentPage,
  "PUT /api/channels/general/read": markRead,
  "PUT /api/threads/42/read": { ok: true, last_read_id: 45 },
};

const meta = {
  title: "Web/Layouts/Full Agora",
  component: AgoraLayout,
  parameters: {
    layout: "fullscreen",
    apiRoutes: routes,
    // AgoraLayout resolves window.location against the seeded selection, so
    // pin the URL to the state this story seeds.
    setup: () => {
      history.replaceState(null, "", "/g/product/c/general");
      useUiState.setState({
        sel: { g: "product", c: "general" },
        view: { kind: "channel" },
        mobileView: "main",
      });
    },
  },
  globals: { viewport: { value: "desktop", isRotated: false } },
} satisfies Meta<typeof AgoraLayout>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ChannelAndGlobalOverlays: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("Component development and responsive review")).resolves.toBeVisible();
    useUiState.getState().setSearchOpen(true);
    await expect(canvas.findByPlaceholderText("Search messages, channels, groups…")).resolves.toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(useUiState.getState().searchOpen).toBe(false);
    expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
  },
};

export const ComposerFocusShortcuts: Story = {
  parameters: {
    apiRoutes: {
      ...routes,
      "GET /api/groups": { groups: fixtureGroups.map(group => ({
        ...group,
        channels: group.channels.map(channel => channel.id === "general" ? { ...channel, unread: 0 } : channel),
      })) },
    },
  },
  play: async ({ canvasElement }) => {
    history.replaceState(null, "", "/g/product/c/general");
    useUiState.setState({ sel: { g: "product", c: "general" }, view: { kind: "channel" }, threadRoot: null, mobileView: "main" });
    const canvas = within(canvasElement);
    const input = await canvas.findByPlaceholderText("Message #storybook");
    markRead.mockClear();
    await userEvent.click(input);
    await userEvent.keyboard("{Escape}");
    expect(input).not.toHaveFocus();
    expect(document.activeElement).toBe(document.body);
    expect(markRead).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(markRead).toHaveBeenCalledTimes(1));
    await userEvent.keyboard("{Enter}");
    expect(input).toHaveFocus();
    expect(input).toHaveValue("");
  },
};

export const ThreadOpen: Story = {
  parameters: {
    apiRoutes: routes,
    setup: () => {
      history.replaceState(null, "", "/g/product/c/general/t/42");
      useUiState.setState({
        sel: { g: "product", c: "general" },
        view: { kind: "channel" },
        mobileView: "thread",
        threadRoot: 42,
      });
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("The 820px phone boundary is covered.")).resolves.toBeVisible();
    expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
  },
};

export const ThreadComposerFocusShortcuts: Story = {
  parameters: {
    setup: () => {
      history.replaceState(null, "", "/g/product/c/general/t/42");
      useUiState.setState({ sel: { g: "product", c: "general" }, view: { kind: "channel" }, mobileView: "thread", threadRoot: 42 });
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = await canvas.findByPlaceholderText(/Reply in thread/);
    await userEvent.click(input);
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).toBe(document.body);
    await userEvent.keyboard("{Enter}");
    expect(input).toHaveFocus();
    await userEvent.keyboard("{Escape}{Escape}");
    await waitFor(() => expect(useUiState.getState().threadRoot).toBeNull());
  },
};
