import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
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
    await userEvent.click(canvas.getByRole("button", { name: "More message actions" }));
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
  name: "Named thread root in narrow pane",
  decorators: [(Story) => <div style={{ width: "min(520px, 100%)" }}><Story /></div>],
  args: {
    message: {
      ...message,
      author_type: "user",
      author_id: "tom",
      author_name: "Tom",
      text: "/new ~/Coding/Projects/agora",
      reactions: [],
      reply_count: 83,
      alias: "A deliberately long thread name that has to be truncated",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const label = await canvas.findByTitle("A deliberately long thread name that has to be truncated");
    await expect(label).toBeVisible();
    // The label belongs to the affordance row, never the message body.
    await expect(label.closest(".ago-bubble-foot")).not.toBeNull();
    await expect(canvas.getByText("83 replies →")).toBeVisible();
    // Truncated (it cannot fit) and flush with the bubble's right edge.
    const box = label.getBoundingClientRect();
    const bubble = label.closest(".ago-bubble")!.getBoundingClientRect();
    await expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
    await expect(bubble.right - box.right).toBeLessThan(20);
    // Width is claimed from the row, not reserved: it never pushes the bubble
    // wider than the message, and it never collapses to nothing.
    await expect(box.width).toBeGreaterThan(40);
    await expect(box.width).toBeLessThanOrEqual(bubble.width);
  },
};

/* Row width follows the pane, so the same alias fits on a wide canvas. */
export const NamedThreadRootWidensWithMessage: Story = {
  name: "Named thread root in wide pane",
  decorators: [(Story) => (
    <div className="ago-log" style={{ width: 1300 }}>
      <Story />
    </div>
  )],
  args: {
    message: {
      ...message,
      author_type: "user",
      author_id: "tom",
      author_name: "Tom",
      text: "/new ~/Coding/Projects/agora --resume --model opus --permission-mode acceptEdits",
      reactions: [],
      reply_count: 83,
      alias: "A deliberately long thread name that has to be truncated",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const label = await canvas.findByTitle("A deliberately long thread name that has to be truncated");
    await expect(label).toBeVisible();
    // The same alias truncates in NamedThreadRoot; here there is room for all
    // of it. Both cases stay anchored to the row’s right edge.
    await expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
    const bubble = label.closest(".ago-bubble")!.getBoundingClientRect();
    await expect(bubble.right - label.getBoundingClientRect().right).toBeLessThan(20);
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

export const GroupedMessage: Story = {
  args: {
    grouped: true,
    message: { ...message, text: "A follow-up keeps the same author gutter.", reactions: [], meta: {} },
  },
};

export const PhoneMessageActions: Story = {
  globals: { viewport: { value: "phone", isRotated: false } },
  parameters: { viewport: { defaultViewport: "phone" } },
  args: {
    message: { ...message, author_type: "user", author_id: "tom", text: "A message with secondary actions.", reactions: [], meta: {} },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = canvas.getByRole("button", { name: "More message actions" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(canvas.getByTitle("Delete this message")).not.toBeVisible();
    await userEvent.click(toggle);
    await expect(canvas.getByTitle("Delete this message")).toBeVisible();
    await userEvent.click(toggle);
    await expect(canvas.getByTitle("Delete this message")).not.toBeVisible();
  },
};


export const ChartControls: Story = {
  args: {
    message: {
      ...message,
      text: "```echarts\n" + JSON.stringify({
        title: { text: "Activity" }, xAxis: { data: ["Mon", "Tue"] },
        yAxis: {}, series: [{ type: "bar", data: [3, 7] }],
      }) + "\n```",
      reactions: [], meta: {},
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelector(".ago-chart-block canvas")).not.toBeNull(), { timeout: 10000 });
    await userEvent.click(canvas.getByRole("button", { name: "More message actions" }));
    const expand = canvas.getByRole("button", { name: "Expand chart: Activity" });
    expand.scrollIntoView({ block: "center" });
    const rect = expand.getBoundingClientRect();
    const hit = canvasElement.ownerDocument.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    expect(expand.contains(hit)).toBe(true);
    await userEvent.click(expand);
    const page = within(canvasElement.ownerDocument.body);
    await expect(page.findByRole("dialog", { name: "Activity" })).resolves.toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Close chart" }));
  },
};

export const GroupedChartControls: Story = {
  ...ChartControls,
  args: { ...ChartControls.args, grouped: true },
};

export const ConversationCards: Story = {
  render: args => <>
    <MessageItem {...args} message={{ ...message, id: 801, author_type: "agent", author_id: "codex", author_name: "Codex", text: "The release checklist is ready. I’ve checked the desktop and phone layouts.", reactions: [], meta: {} }} />
    <MessageItem {...args} message={{ ...message, id: 802, author_type: "user", author_id: "tom", author_name: "Tom", text: "Thanks. Please include the settings and member lists in the review too.", reactions: [], meta: {} }} />
    <MessageItem {...args} message={{ ...message, id: 803, author_type: "user", author_id: "alice", author_name: "Alice", text: "I’ll check the populated roster and long names on my phone.", reactions: [], meta: {} }} />
  </>,
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelector(".ago-msg-row.is-mine")).not.toBeNull());
    const own = canvasElement.querySelector(".ago-msg-row.is-mine")!;
    const peer = canvasElement.querySelector(".ago-msg-row.is-peer")!;
    expect(own.getBoundingClientRect().left).toBeGreaterThan(peer.getBoundingClientRect().left);
    for (const bubble of canvasElement.querySelectorAll(".bubble")) {
      expect(parseFloat(getComputedStyle(bubble).borderTopWidth)).toBeGreaterThan(0);
      const prose = bubble.querySelector(".md-text-segment")!;
      expect(prose.scrollWidth).toBeLessThanOrEqual(prose.clientWidth + 1);
    }
  },
};
