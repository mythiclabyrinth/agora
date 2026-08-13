import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { fixtureGroups } from "@agora/core/testing/fixtures";
import { useUiState } from "../state/ui";
import { AttachmentBrowser } from "./AttachmentBrowser";

const deleted = fn(() => ({
  id: 21, channel_id: "general", thread_id: 20, author_type: "user", author_id: "tom",
  author_name: "Tom", text: "Here is the design", ts: 1_750_000_000, attachments: [], reactions: [],
}));
const channelPage = {
  items: [
    { id: "plan", filename: "launch-plan.pdf", mime: "application/pdf", size: 524288,
      channel_id: "general", message_id: 21, thread_id: 20, author_type: "user", author_id: "tom",
      author_name: "Tom", message_text: "Here is the design", ts: 1_750_000_000,
      thread_name: "Launch readiness review", can_delete: true },
    { id: "shot", filename: "dashboard.png", mime: "image/png", size: 1200000,
      channel_id: "general", message_id: 10, thread_id: null, author_type: "agent", author_id: "codex",
      author_name: "Codex", message_text: "Dashboard preview", ts: 1_749_999_000,
      thread_name: null, can_delete: false },
  ], has_more: false, offset: 0,
};

const meta = {
  title: "Web/Connected/Attachment browser",
  component: AttachmentBrowser,
  parameters: {
    apiRoutes: {
      "GET /api/groups": { groups: fixtureGroups },
      "GET /api/channels/general/attachments?offset=0": channelPage,
      "GET /api/channels/general/attachments?offset=0&thread_id=20": {
        items: [channelPage.items[0]], has_more: false, offset: 0,
      },
      "DELETE /api/channels/general/attachments/plan": deleted,
    },
    setup: () => useUiState.setState({
      sel: { g: "product", c: "general" }, filesOpen: true, filesThread: null,
    }),
    layout: "centered",
  },
} satisfies Meta<typeof AttachmentBrowser>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ChannelWithRenamedThread: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("launch-plan.pdf")).resolves.toBeVisible();
    await expect(canvas.findByText("Launch readiness review")).resolves.toBeVisible();
    await expect(canvas.findByText("dashboard.png")).resolves.toBeVisible();
    const remove = canvas.getByTitle("Delete attachment");
    await userEvent.click(remove);
    await expect(canvas.findByTitle("Click again to delete from Agora")).resolves.toBeVisible();
    await userEvent.click(canvas.getByTitle("Click again to delete from Agora"));
    await expect(deleted).toHaveBeenCalled();
  },
};

export const ThreadOnly: Story = {
  parameters: { setup: () => useUiState.setState({
    sel: { g: "product", c: "general" }, filesOpen: true, filesThread: 20,
  }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("this thread")).resolves.toBeVisible();
    await expect(canvas.findByText("launch-plan.pdf")).resolves.toBeVisible();
    expect(canvas.queryByText("dashboard.png")).toBeNull();
    expect(canvas.queryByText("Launch readiness review")).toBeNull();
  },
};
