import type { Meta, StoryObj } from "@storybook/react-native";
import { fixtureGroups, fixtureThreads } from "@agora/core/testing/fixtures";
import Home from "../../app/(app)/index";
import { usePrefs } from "../state/prefs";

const meta = {
  title: "Native/Screens/Home",
  component: Home,
  parameters: { apiRoutes: {
    "GET /api/groups": { groups: fixtureGroups },
    "GET /api/threads?limit=100": { threads: fixtureThreads },
    "GET /api/dms": { conversations: [], agents: [] },
  } },
} satisfies Meta<typeof Home>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Populated: Story = {};
export const Empty: Story = { parameters: { apiRoutes: {
  "GET /api/groups": { groups: [] },
  "GET /api/threads?limit=100": { threads: [] },
} } };
export const UnreadOnly: Story = { parameters: {
  setup: () => usePrefs.setState({ unreadsOnly: true }),
} };
export const LongNames: Story = { parameters: { apiRoutes: {
  "GET /api/groups": { groups: fixtureGroups.map(group => ({ ...group,
    name: "Research and product development across all workspaces",
    channels: group.channels.map(channel => ({ ...channel,
      name: "customer-feedback-and-product-strategy", unread: 125, mentions: 104,
    })),
  })) },
} } };
