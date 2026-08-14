import type { Meta, StoryObj } from "@storybook/react-native";
import {
  fixtureAgents,
  fixtureGroups,
  fixtureMembers,
  fixtureUsers,
} from "@agora/core/testing/fixtures";
import MembersScreen from "../../app/(app)/members/[groupId]";

const routes = {
  "GET /api/groups": { groups: fixtureGroups },
  "GET /api/groups/product/members": { members: [
    ...fixtureMembers.filter(member => member.member_id !== "alice"),
    { channel_id: "general", member_type: "user", member_id: "alice", role: "admin", added_at: 1_750_000_100, name: "Alice" },
    { channel_id: "responsive", member_type: "user", member_id: "alice", role: "member", added_at: 1_750_000_101, name: "Alice" },
  ] },
  "GET /api/agents": { agents: fixtureAgents },
  "GET /api/users": { users: fixtureUsers },
};

const meta = {
  title: "Native/Screens/Members",
  component: MembersScreen,
  parameters: {
    apiRoutes: routes,
    setup: () => {
      (globalThis as typeof globalThis & {
        __AGORA_STORY_PARAMS__?: Record<string, string>;
      }).__AGORA_STORY_PARAMS__ = { groupId: "product", name: "Product" };
    },
  },
} satisfies Meta<typeof MembersScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AdminRoster: Story = {};
