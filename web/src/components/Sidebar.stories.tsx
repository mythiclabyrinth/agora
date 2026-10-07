import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import {
  useLive,
  type Group,
  type TypingEvent,
} from "@agora/core";
import {
  fixtureGroups,
  fixtureMe,
  fixtureThreads,
} from "@agora/core/testing/fixtures";
import { useUiState } from "../state/ui";
import { Sidebar } from "./Sidebar";
import { useShortcuts } from "../hooks/useShortcuts";

const routes = {
  "GET /api/me": fixtureMe,
  "GET /api/groups": { groups: fixtureGroups },
  "GET /api/threads?limit=100": { threads: fixtureThreads },
  "GET /api/unreads": { items: [] },
  "PATCH /api/threads/42": { ok: true },
};
const groupsWithoutMentions = fixtureGroups.map(group => ({
  ...group,
  channels: group.channels.map(channel => ({ ...channel, mentions: 0 })),
}));
const dmGroups: Group[] = [...fixtureGroups, {
  id: "dms", name: "Direct messages", description: "", created_by: "tom", created_at: 1_750_000_000,
  role: "admin", is_public: false, kind: "agent_dms",
  channels: [{ id: "dm-claude", group_id: "dms", name: "Claude M5", topic: "", created_at: 1_750_000_000, unread: 0, mentions: 0 }],
}];

const activity = (channel_id: string, agent_id: string, agent_name: string, thread_id: number | null = null): TypingEvent => ({
  type: "typing", channel_id, thread_id, agent_id, agent_name, active: true,
});

function setup(): void {
  localStorage.removeItem("agora_chan_collapsed");
  useUiState.setState({
    sel: { g: "product", c: "general" },
    view: { kind: "channel" },
    mobileView: "main",
    expanded: ["product"],
    collapsedChannels: [],
  });
}

function setupReplying(multiple = false, collapsed = false): void {
  setup();
  useLive.getState().seedAll({ channels: {
    general: { typing: [
      activity("general", "claude", "Claude M5"),
      ...(multiple ? [activity("general", "codex", "Codex")] : []),
    ], progress: [] },
    "dm-claude": { typing: [activity("dm-claude", "claude", "Claude M5")], progress: [] },
    responsive: { typing: [activity("responsive", "codex", "Codex", 42)], progress: [] },
  } }, useLive.getState().epoch);
  useUiState.setState({ expanded: collapsed ? [] : ["product", "dms"] });
}

const meta = {
  title: "Web/Navigation/Sidebar",
  component: Sidebar,
  parameters: {
    layout: "fullscreen",
    apiRoutes: routes,
    setup,
  },
  decorators: [Story => <div style={{ width: 280, height: "100vh" }}><Story /></div>],
} satisfies Meta<typeof Sidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ChannelThreadsExpanded: Story = {
  parameters: {
    apiRoutes: { ...routes, "GET /api/groups": { groups: groupsWithoutMentions } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const collapse = await canvas.findByRole("button", { name: "Collapse threads in #storybook" });
    const channel = within(collapse.closest(".ago-chan") as HTMLElement);
    await expect(canvas.findByText("Can we validate the responsive component layout?")).resolves.toBeVisible();
    expect(channel.getByText("4")).toBeVisible();
    await userEvent.click(collapse);
    expect(collapse).toHaveAttribute("aria-expanded", "false");
    expect(canvas.queryByText("Can we validate the responsive component layout?")).not.toBeInTheDocument();
    expect(channel.getByText("5")).toBeVisible();
    expect(useUiState.getState().collapsedChannels).toEqual(["general"]);
    expect(localStorage.getItem("agora_chan_collapsed")).toBe('["general"]');
  },
};

export const RenameThreadDialog: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const thread = await canvas.findByText("Can we validate the responsive component layout?");
    await userEvent.hover(thread);
    const renameButton = canvas.getByTitle("Rename this thread");
    await userEvent.click(renameButton);
    let dialog = within(await within(document.body).findByRole("dialog", { name: "Rename thread" }));
    await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(useUiState.getState().threadRoot).toBeNull();
    await waitFor(() => expect(renameButton).toHaveFocus());
    await userEvent.click(renameButton);
    dialog = within(await within(document.body).findByRole("dialog", { name: "Rename thread" }));
    const input = dialog.getByLabelText("Thread name");
    await waitFor(() => expect(input).toHaveFocus());
    await userEvent.clear(input);
    await userEvent.type(input, "Desktop sidebar review");
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(document.body).queryByRole("dialog", { name: "Rename thread" })).not.toBeInTheDocument());
  },
};

export const IndependentGroupExpansion: Story = {
  parameters: { apiRoutes: { ...routes, "GET /api/groups": { groups: [
    ...fixtureGroups,
    { ...fixtureGroups[0], id: "another-group", name: "Another group", channels: [] },
  ] } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Expand Another group" }));
    expect(useUiState.getState().expanded).toContain("product");
    expect(useUiState.getState().expanded).toContain("another-group");
    await userEvent.click(canvas.getByRole("button", { name: "Collapse Another group" }));
    expect(useUiState.getState().expanded).toContain("product");
    expect(JSON.parse(localStorage.getItem("agora_open") || "[]")).toContain("product");
  },
};

export const AgentReplying: Story = {
  parameters: {
    apiRoutes: { ...routes, "GET /api/groups": { groups: dmGroups } },
    setup: () => setupReplying(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findAllByRole("img", { name: "Claude M5 is replying" })).toHaveLength(2);
    expect(canvas.queryByRole("img", { name: "Codex is replying" })).not.toBeInTheDocument();
  },
};

export const AgentReplyingInThread: Story = {
  parameters: {
    setup: () => {
      setup();
      useLive.getState().seedAll({ channels: {
        general: { typing: [activity("general", "claude", "Claude M5", 42)], progress: [] },
      } }, useLive.getState().epoch);
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const threadText = await canvas.findByText("Can we validate the responsive component layout?");
    const thread = threadText.closest(".ago-side-thread") as HTMLElement;
    expect(within(thread).getByRole("img", { name: "Claude M5 is replying" })).toBeVisible();
    const channel = canvas.getByText("storybook").closest(".ago-chan") as HTMLElement;
    expect(within(channel).queryByRole("img", { name: "Claude M5 is replying" })).not.toBeInTheDocument();
  },
};

export const AgentReplyingMultiple: Story = {
  parameters: { setup: () => setupReplying(true) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByRole("img", { name: "Claude M5, Codex are replying" })).toBeVisible();
  },
};

export const AgentReplyingUnreadsOnly: Story = {
  parameters: {
    apiRoutes: { ...routes, "GET /api/groups": { groups: dmGroups } },
    setup: () => setupReplying(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findAllByRole("img", { name: "Claude M5 is replying" });
    await userEvent.click(canvas.getByTitle("Show unreads only"));
    expect(canvas.getAllByRole("img", { name: "Claude M5 is replying" })).toHaveLength(2);
    expect(canvas.queryByText("responsive-web")).not.toBeInTheDocument();
  },
};

export const AgentReplyingCollapsedGroup: Story = {
  parameters: { setup: () => setupReplying(false, true) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByRole("img", { name: "Claude M5 is replying" })).toBeVisible();
    expect(canvas.queryByText("responsive-web")).not.toBeInTheDocument();
  },
};

function SidebarWithShortcuts() {
  useShortcuts();
  return <Sidebar />;
}

export const ShortcutFollowsVisibleOrder: Story = {
  parameters: {
    apiRoutes: { ...routes, "GET /api/groups": { groups: [
      { ...dmGroups[1], channels: [{ ...dmGroups[1].channels[0], unread: 1 }] },
      ...fixtureGroups,
    ] } },
    setup: () => {
      setup();
      useUiState.setState({ expanded: ["product", "dms"], unreadsOnly: true });
    },
  },
  render: () => <SidebarWithShortcuts />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelectorAll(".ago-chan[data-channel-id]")).toHaveLength(2));
    expect([...canvasElement.querySelectorAll<HTMLElement>(".ago-chan[data-channel-id]")].map(row => row.dataset.channelId)).toEqual(["general", "dm-claude"]);
    await userEvent.click(canvas.getByRole("button", { name: /Inbox/ }));
    useUiState.getState().selectChannel("product", "general");
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await waitFor(() => expect(useUiState.getState().sel.c).toBe("dm-claude"));
  },
};
