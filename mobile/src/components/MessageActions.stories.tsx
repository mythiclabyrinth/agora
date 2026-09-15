import type { Meta, StoryObj } from "@storybook/react-native";
import { fn } from "storybook/test";
import { fixtureRootMessage } from "@agora/core/testing/fixtures";
import { MessageActions } from "./MessageActions";

const edited = { ...fixtureRootMessage, text: "First paragraph.\n\nSecond paragraph with **Markdown**." };
const meta = {
  title: "Native/Messages/Message actions",
  component: MessageActions,
  args: {
    message: edited,
    channelId: edited.channel_id,
    groupId: "product",
    starred: false,
    pinned: false,
    canPin: true,
    canEdit: true,
    canDelete: true,
    onClose: fn(),
    onReact: fn(),
    onThread: fn(),
  },
  parameters: {
    apiRoutes: {
      [`PATCH /api/channels/${edited.channel_id}/messages/${edited.id}`]: {
        ...edited, text: "Edited in Storybook", meta: { edited_at: 1_700_000_100 },
      },
    },
  },
} satisfies Meta<typeof MessageActions>;

export default meta;
type Story = StoryObj<typeof meta>;
export const OwnMessage: Story = {};
export const InfoAction: Story = {
  args: {
    message: { ...edited, alias: "Release readiness", reply_count: 3 },
  },
};
export const OtherUsersMessage: Story = { args: { canEdit: false, canDelete: false } };
export const ThreadReply: Story = {
  args: {
    message: { ...edited, id: edited.id + 1, thread_id: edited.id, reply_count: undefined },
    onThread: undefined,
  },
};
