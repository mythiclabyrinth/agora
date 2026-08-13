import type { Meta, StoryObj } from "@storybook/react-vite";
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
    await userEvent.click(canvas.getByTitle("Rename this thread"));
    let dialog = within(await within(document.body).findByRole("dialog", { name: "Rename thread" }));
    await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(useUiState.getState().threadRoot).toBeNull();
    await userEvent.click(canvas.getByTitle("Rename this thread"));
    dialog = within(await within(document.body).findByRole("dialog", { name: "Rename thread" }));
    const input = dialog.getByLabelText("Thread name");
    await expect(input).toHaveFocus();
    await userEvent.clear(input);
    await userEvent.type(input, "Desktop sidebar review");
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(document.body).queryByRole("dialog", { name: "Rename thread" })).not.toBeInTheDocument());
  },
};
