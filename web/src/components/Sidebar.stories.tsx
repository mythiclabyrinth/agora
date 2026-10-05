import type { Meta, StoryObj } from "@storybook/react-vite";
import { flushSync } from "react-dom";
import { expect, userEvent, waitFor, within } from "storybook/test";
import {
  fixtureGroups,
  fixtureMe,
  fixtureThreads,
} from "@agora/core/testing/fixtures";
import { useUiState } from "../state/ui";
import { Sidebar } from "./Sidebar";

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
    // Reopen before the next frame so the old dialog's deferred focus restore
    // runs against the new input. Awaited user events made this race intermittent.
    flushSync(() => dialog.getByRole("button", { name: "Cancel" }).click());
    expect(useUiState.getState().threadRoot).toBeNull();
    expect(within(document.body).queryByRole("dialog", { name: "Rename thread" })).not.toBeInTheDocument();
    renameButton.focus();
    flushSync(() => renameButton.click());
    dialog = within(within(document.body).getByRole("dialog", { name: "Rename thread" }));
    const input = dialog.getByLabelText("Thread name");
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    await expect(input).toHaveFocus();
    await userEvent.clear(input);
    await userEvent.type(input, "Desktop sidebar review");
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(document.body).queryByRole("dialog", { name: "Rename thread" })).not.toBeInTheDocument());
    await waitFor(() => expect(renameButton).toHaveFocus());
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
