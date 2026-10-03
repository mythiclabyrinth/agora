import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { fixtureGroups, fixtureMe, fixtureThreads } from "@agora/core/testing/fixtures";
import type { UnreadItem } from "@agora/core";
import { Inbox } from "./Inbox";

const now = Date.now() / 1000;
const channel: UnreadItem = {
  kind: "channel", channel_id: "general", channel_name: "general", group_id: "product", group_name: "Product",
  thread_id: null, title: null, unread: 2, mentions: 0, first_unread_id: 44, ack_through_id: 45,
  latest_ts: now, previews: [
    { ...fixtureThreads[0].root, id: 44, text: "The build is ready to check", thread_id: null },
    { ...fixtureThreads[0].root, id: 45, text: "Please review the result", thread_id: null },
  ],
};
const thread: UnreadItem = {
  ...channel, kind: "thread", thread_id: 42, title: "Launch planning", unread: 1,
  mentions: 1, first_unread_id: 46, ack_through_id: 46,
  previews: [{ ...fixtureThreads[0].root, id: 46, text: "@tom could you review?", thread_id: 42 }],
};

const meta = {
  title: "Web/Connected/Inbox",
  component: Inbox,
  parameters: {
    apiRoutes: {
      "GET /api/me": fixtureMe,
      "GET /api/groups": { groups: fixtureGroups },
      "GET /api/threads?limit=100": { threads: fixtureThreads },
      "GET /api/unreads": { items: [thread, channel], total: 2 },
      "PUT /api/unreads/read": { ok: true, marked: 1 },
    },
    setup: () => history.replaceState(null, "", "/inbox/unreads"),
  },
} satisfies Meta<typeof Inbox>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText(/Launch planning in/)).resolves.toBeVisible();
    await userEvent.click(canvas.getByRole("tab", { name: "Threads" }));
    await expect(canvas.findByText("Can we validate the responsive component layout?")).resolves.toBeVisible();
    await userEvent.click(canvas.getByRole("tab", { name: /Unreads/ }));
    await userEvent.click(canvas.getByRole("button", { name: "Mark thread read" }));
  },
};

export const Empty: Story = { parameters: { apiRoutes: { "GET /api/unreads": { items: [], total: 0 } }, setup: () => history.replaceState(null, "", "/inbox/unreads") } };
export const Limited: Story = { parameters: {
  apiRoutes: { "GET /api/unreads": { items: [thread, channel], total: 245 } },
  setup: () => history.replaceState(null, "", "/inbox/unreads"),
} };
export const Mentions: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "@Mentions" }));
    await expect(canvas.findByText(/Launch planning in/)).resolves.toBeVisible();
    await expect(canvas.queryByText("The build is ready to check")).toBeNull();
  },
};
export const Threads: Story = { parameters: { setup: () => history.replaceState(null, "", "/inbox/threads") } };
