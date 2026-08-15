import type { Meta, StoryObj } from "@storybook/react-native";
import { fixtureGroups, fixtureMe, fixtureUsers } from "@agora/core/testing/fixtures";
import PersonAccessScreen from "../../app/(app)/people/[username]";

const memberships = [
  { group_id: "product", group_name: "Product", channel_id: null, channel_name: null, member_type: "user", member_id: "alice", role: "member", added_at: 1 },
  { group_id: "product", group_name: "Product", channel_id: "responsive", channel_name: "responsive-web", member_type: "user", member_id: "alice", role: "admin", added_at: 2 },
];

const meta = {
  title: "Native/Screens/Person access",
  component: PersonAccessScreen,
  parameters: {
    apiRoutes: {
      "GET /api/me": { ...fixtureMe, instance_admin: true },
      "GET /api/users": { users: fixtureUsers },
      "GET /api/memberships": { memberships },
      "GET /api/groups": { groups: fixtureGroups },
    },
    setup: () => {
      (globalThis as typeof globalThis & { __AGORA_STORY_PARAMS__?: Record<string, string> }).__AGORA_STORY_PARAMS__ = { username: "alice" };
    },
  },
} satisfies Meta<typeof PersonAccessScreen>;

export default meta;
type Story = StoryObj<typeof meta>;
export const AccessOverview: Story = {};
