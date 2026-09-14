import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { Message } from "@agora/core";
import { fixtureAgents } from "@agora/core/testing/fixtures";
import { MessageItem } from "./MessageItem";
import { me, message } from "../stories/fixtures/data";

const richMessage: Message = {
  ...message,
  text: "Here is the implementation summary with a [reference](https://storybook.js.org/).\n\nSources:\nhttps://storybook.js.org/",
  reply_count: 3,
  attachments: [{
    id: "plan",
    filename: "component-plan.pdf",
    mime: "application/pdf",
    size: 428_032,
  }],
  reactions: [
    { emoji: "👍", users: ["tom", "alice"] },
    { emoji: "🎉", users: ["alice"] },
  ],
  meta: {
    tldr: "The Storybook implementation is ready for component inspection.",
    sources_start: 91,
    sources: [{
      url: "https://storybook.js.org/",
      title: "Storybook documentation",
      site: "storybook.js.org",
    }],
    unfurls: [{
      url: "https://storybook.js.org/",
      site: "storybook.js.org",
      title: "Storybook",
      description: "Build and test UI components in isolation.",
    }],
    options_id: "review",
    options: [
      { id: "approve", label: "Approve", style: "primary" },
      { id: "revise", label: "Request changes" },
    ],
  },
};

const baseRoutes = {
  "GET /api/me": me,
  "GET /api/agents": { agents: fixtureAgents },
  "GET /api/channels/general/pins": { pins: [] },
  "GET /api/channels/general/stars": { stars: [] },
};

const meta = {
  title: "Web/Messages/Message item",
  component: MessageItem,
  decorators: [(Story) => (
    <div className="ago-log" style={{ width: "min(760px, 100%)" }}>
      <Story />
    </div>
  )],
  args: {
    message: richMessage,
    inThread: false,
    isAdmin: true,
    mentions: {},
    onOpenThread: fn(),
  },
  parameters: { apiRoutes: baseRoutes },
} satisfies Meta<typeof MessageItem>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AgentRichContent: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("Codex · agent")).resolves.toBeVisible();
    await expect(canvas.findByRole("button", { name: /tom, alice reacted with 👍/ })).resolves.toBeVisible();
    await expect(canvas.findByTitle("Pin this thread for quick access")).resolves.toBeInTheDocument();
    expect(canvas.queryByTitle("Star this message")).not.toBeInTheDocument();
  },
};

export const CurrentUser: Story = {
  args: {
    message: {
      ...message,
      author_type: "user",
      author_id: "tom",
      author_name: "Tom",
      text: "This is how a message from the signed-in user is presented.",
      reactions: [],
    },
  },
  parameters: {
    apiRoutes: {
      ...baseRoutes,
      "PATCH /api/channels/general/messages/42": {
        ...message,
        author_type: "user",
        author_id: "tom",
        author_name: "Tom",
        text: "Edited in Storybook.",
        meta: { edited_at: 1_700_000_100 },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const bubble = (await canvas.findByText("This is how a message from the signed-in user is presented."))
      .closest(".bubble");
    await expect(bubble).toHaveClass("user");
    expect(canvas.queryByText(/· agent/)).not.toBeInTheDocument();
    await userEvent.click(canvas.getByTitle("Edit this message"));
    const editor = canvas.getByRole("textbox", { name: "Edit message" });
    await expect(editor).toHaveValue("This is how a message from the signed-in user is presented.");
    await userEvent.clear(editor);
    await userEvent.type(editor, "Edited in Storybook.");
    await userEvent.click(canvas.getByRole("button", { name: "Save" }));
    await expect(canvas.findByTitle("Edit this message")).resolves.toBeInTheDocument();
    expect(canvas.queryByRole("textbox", { name: "Edit message" })).not.toBeInTheDocument();
  },
};

/* Two roots whose text is identical: only the thread name tells them apart. */
export const NamedThreadRoot: Story = {
  args: {
    message: {
      ...message,
      author_type: "user",
      author_id: "tom",
      author_name: "Tom",
      text: "/new ~/Coding/Projects/agora",
      reactions: [],
      reply_count: 83,
      alias: "Agora history paging",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const label = await canvas.findByTitle("Agora history paging");
    await expect(label).toBeVisible();
    // The label belongs to the affordance row, never the message body.
    await expect(label.closest(".ago-bubble-foot")).not.toBeNull();
    await expect(canvas.getByText("83 replies →")).toBeVisible();
  },
};

export const UnnamedThreadRoot: Story = {
  args: {
    message: {
      ...message,
      author_type: "user",
      author_id: "tom",
      author_name: "Tom",
      text: "/new ~/Coding/Projects/agora",
      reactions: [],
      reply_count: 83,
      alias: null,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("83 replies →")).resolves.toBeVisible();
    expect(canvasElement.querySelector(".ago-thread-alias")).toBeNull();
  },
};

export const EditedMessage: Story = {
  args: {
    message: {
      ...message,
      author_type: "user",
      author_id: "tom",
      author_name: "Tom",
      meta: { edited_at: 1_700_000_100 },
      text: "This message was edited after it was sent.",
    },
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).findByText(/edited ·/)).resolves.toBeInTheDocument();
  },
};

export const NonAdminOtherUser: Story = {
  args: {
    isAdmin: false,
    message: {
      ...message,
      author_type: "user",
      author_id: "alice",
      author_name: "Alice",
      text: "A member cannot delete another member's message.",
      reactions: [],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("A member cannot delete another member's message.")).resolves.toBeVisible();
    expect(canvas.queryByTitle("Delete this message")).not.toBeInTheDocument();
  },
};

export const ThreadReply: Story = {
  args: {
    inThread: true,
    message: {
      ...richMessage,
      id: 44,
      thread_id: 42,
      reply_count: 0,
      text: "A reply suppresses top-level thread and pin controls.",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("A reply suppresses top-level thread and pin controls.")).resolves.toBeVisible();
    expect(canvas.queryByTitle("Pin this thread for quick access")).not.toBeInTheDocument();
  },
};

export const LongContent: Story = {
  args: {
    message: {
      ...richMessage,
      text: [
        "## Responsive content",
        "",
        "A long message should remain readable at narrow viewport sizes.",
        "",
        "| Surface | Expected behavior |",
        "| --- | --- |",
        "| Desktop | Full pane layout |",
        "| Phone | Single-pane drill-down |",
        "",
        "agora-responsive-token-".repeat(12),
      ].join("\n"),
      meta: { tldr: "Long content remains constrained to its message pane." },
    },
  },
  globals: { viewport: { value: "phone", isRotated: false } },
  parameters: { viewport: { defaultViewport: "phone" } },
};
