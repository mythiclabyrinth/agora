import type { Meta, StoryObj } from "@storybook/react-native";
import { fixtureGroups, fixtureThreads } from "@agora/core/testing/fixtures";
import InboxScreen from "../../app/(app)/inbox";
import { GestureHandlerRootView } from "react-native-gesture-handler";

const root = fixtureThreads[0].root;
const item = {
  kind: "channel", channel_id: "general", channel_name: "general", group_id: "product", group_name: "Product",
  thread_id: null, title: null, unread: 2, mentions: 0, first_unread_id: 44, ack_through_id: 45,
  latest_ts: Date.now() / 1000,
  previews: [{ ...root, id: 44, text: "The build is ready", thread_id: null }],
};
const meta = {
  title: "Native/Screens/Inbox",
  component: InboxScreen,
  parameters: { apiRoutes: {
    "GET /api/groups": { groups: fixtureGroups },
    "GET /api/threads?limit=100": { threads: fixtureThreads },
    "GET /api/unreads": { items: [item, { ...item, kind: "thread", thread_id: 42, title: "Launch planning", mentions: 1 }], total: 2 },
  } },
} satisfies Meta<typeof InboxScreen>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Populated: Story = {};
export const Limited: Story = {
  parameters: { apiRoutes: { "GET /api/unreads": { items: [item], total: 245 } } },
};
export const SwipeMarkRead: Story = {
  render: () => <GestureHandlerRootView style={{ flex: 1 }}>
    <InboxScreen initialTab="unreads" initialSwipe="left" />
  </GestureHandlerRootView>,
};
export const Empty: Story = {
  render: () => <InboxScreen initialTab="unreads" />,
  parameters: { apiRoutes: { "GET /api/unreads": { items: [], total: 0 } } },
};
