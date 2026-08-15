import type { Meta, StoryObj } from "@storybook/react-native";
import type { AttachmentBrowserItem } from "@agora/core";
import { AttachmentBrowser } from "./AttachmentBrowser";

const session = { baseUrl: "https://storybook.invalid", token: "storybook" };
const previewSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#27234f"/><circle cx="80" cy="75" r="30" fill="#38e1c8"/><path d="M20 210l90-90 55 55 45-45 90 80" fill="#8b7cff"/></svg>';
const imageSource = () => ({ uri: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(previewSvg)}` });
const items: AttachmentBrowserItem[] = [
  { id: "image", filename: "launch-dashboard.png", mime: "image/png", size: 1_104_000, channel_id: "general", message_id: 42, thread_id: 40, author_type: "user", author_id: "tom", author_name: "Tom", message_text: "Dashboard", ts: 1_750_000_000, thread_name: "Launch readiness review", can_delete: true },
  { id: "plan", filename: "launch-plan.pdf", mime: "application/pdf", size: 512_000, channel_id: "general", message_id: 39, thread_id: null, author_type: "agent", author_id: "codex", author_name: "Codex", message_text: "Plan", ts: 1_749_999_000, thread_name: null, can_delete: false },
];
const meta = {
  title: "Native/Screens/Attachment Browser",
  component: AttachmentBrowser,
  args: { channelId: "general", threadId: null, session, onOpenMessage: () => {}, imageSource },
  parameters: { apiRoutes: { "GET /api/channels/general/attachments?offset=0": { items, has_more: false, offset: 0 } } },
} satisfies Meta<typeof AttachmentBrowser>;

export default meta;
type Story = StoryObj<typeof meta>;
export const ChannelAttachments: Story = {};
export const ThreadAttachments: Story = {
  args: { threadId: 40 },
  parameters: { apiRoutes: { "GET /api/channels/general/attachments?offset=0&thread_id=40": { items: [items[0]], has_more: false, offset: 0 } } },
};
export const Empty: Story = {
  parameters: { apiRoutes: { "GET /api/channels/general/attachments?offset=0": { items: [], has_more: false, offset: 0 } } },
};
