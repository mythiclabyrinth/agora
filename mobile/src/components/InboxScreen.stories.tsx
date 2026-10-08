import type { Meta, StoryObj } from "@storybook/react-native";
import React from "react";
import { fixtureGroups, fixtureThreads } from "@agora/core/testing/fixtures";
import InboxScreen from "../../app/(app)/inbox";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useInboxTab } from "../state/inboxTab";

function ResetInboxState({ children }: { children: React.ReactNode }) {
  React.useState(() => useInboxTab.setState({ tab: "unreads", filter: "all" }));
  return <>{children}</>;
}

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
  decorators: [(Story) => <ResetInboxState><Story /></ResetInboxState>],
  parameters: { apiRoutes: {
    "GET /api/groups": { groups: fixtureGroups },
    "GET /api/threads?limit=100": { threads: fixtureThreads },
    "GET /api/unreads": { items: [item, { ...item, kind: "thread", thread_id: 42, title: "Launch planning", mentions: 1 }], total: 2 },
    "GET /api/approvals": { items: [], total: 0 },
  } },
} satisfies Meta<typeof InboxScreen>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Populated: Story = {};
export const UnreadsAtRest: Story = {
  render: () => <GestureHandlerRootView style={{ flex: 1 }}>
    <InboxScreen />
  </GestureHandlerRootView>,
};
export const Limited: Story = {
  parameters: { apiRoutes: { "GET /api/unreads": { items: [item], total: 245 } } },
};
export const UnreadsSwipeLeftMarkRead: Story = {
  render: () => <GestureHandlerRootView style={{ flex: 1 }}>
    <InboxScreen initialSwipe="left" />
  </GestureHandlerRootView>,
};
export const Empty: Story = {
  render: () => <InboxScreen />,
  parameters: { apiRoutes: { "GET /api/unreads": { items: [], total: 0 } } },
};

export const Approvals: Story = {
  render: () => {
    useInboxTab.setState({ tab: "approvals" });
    return <InboxScreen />;
  },
  parameters: { apiRoutes: { "GET /api/approvals": { items: [{
    kind: "channel", channel_id: "general", channel_name: "general", group_id: "product", group_name: "Product",
    thread_id: null, title: null, pending_count: 1,
    message: { ...root, id: 520, author_type: "agent", author_id: "claude-cli", author_name: "Claude", thread_id: null, text: "Please approve this action", ts: Date.now() / 1000,
      meta: { approval_inbox: true, options: [{ id: "allow", label: "Approve", style: "primary" }, { id: "deny", label: "Reject" }] } },
  }], total: 1 } } },
};

export const LongThreadTitle: Story = {
  render: () => <InboxScreen />,
  parameters: { apiRoutes: { "GET /api/unreads": { items: [{ ...item,
    kind: "thread", thread_id: 42,
    title: "Customer interview synthesis and the decisions we need before the next release",
    unread: 125, mentions: 12,
  }], total: 1 } } },
};
