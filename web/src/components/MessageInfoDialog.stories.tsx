import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import type { Message } from "@agora/core";
import { MessageInfoDialog } from "./MessageInfoDialog";
import { message } from "../stories/fixtures/data";

const root: Message = {
  ...message,
  alias: "Release readiness",
  reply_count: 3,
  attachments: [{ id: "report", filename: "report.pdf", mime: "application/pdf", size: 4200 }],
  reactions: [{ emoji: "👍", users: ["tom", "alice"] }],
  meta: { edited_at: message.ts + 60 },
};

const latest: Message = {
  ...message,
  id: message.id + 3,
  thread_id: root.id,
  author_id: "alice",
  author_name: "Alice",
  ts: message.ts + 3600,
  reply_count: undefined,
  alias: null,
};

const meta = {
  title: "Web/Messages/Message info dialog",
  component: MessageInfoDialog,
  args: {
    message: root,
    groupId: "product",
    onClose: fn(),
  },
  parameters: {
    apiRoutes: {
      "GET /api/groups": { groups: [{ id: "product", name: "Product", channels: [{ id: root.channel_id, name: "general" }] }] },
      [`GET /api/channels/${root.channel_id}/messages?thread_id=${root.id}&limit=1`]: {
        messages: [latest],
      },
    },
  },
} satisfies Meta<typeof MessageInfoDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NamedThreadRoot: Story = {
  play: async () => {
    const dialog = within(document.body).getByRole("dialog", { name: "Message info" });
    await expect(within(dialog).getByText("Release readiness")).toBeVisible();
    await expect(within(dialog).getByText("3")).toBeVisible();
    await expect(await within(dialog).findByText(/Alice/)).toBeVisible();
  },
};

export const PlainReply: Story = {
  args: {
    message: {
      ...root,
      id: root.id + 1,
      thread_id: root.id,
      alias: null,
      reply_count: undefined,
      attachments: [],
      reactions: [],
      meta: null,
    },
  },
  play: async () => {
    const dialog = within(document.body).getByRole("dialog", { name: "Message info" });
    await expect(within(dialog).queryByText("Thread name")).not.toBeInTheDocument();
    await expect(within(dialog).queryByText("Latest reply")).not.toBeInTheDocument();
    await expect(within(dialog).queryByText("Replies")).not.toBeInTheDocument();
  },
};
