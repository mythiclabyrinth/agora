import type { Meta, StoryObj } from "@storybook/react-native";
import { fixtureUsers } from "@agora/core/testing/fixtures";
import PeopleScreen from "../../app/(app)/people";

const meta = {
  title: "Native/Screens/People",
  component: PeopleScreen,
  parameters: { apiRoutes: {
    "GET /api/users": { users: fixtureUsers },
    "GET /api/memberships": { memberships: [
      { group_id: "product", group_name: "Product", channel_id: null, channel_name: null, member_type: "user", member_id: "tom", role: "admin", added_at: 1 },
      { group_id: "product", group_name: "Product", channel_id: "general", channel_name: "storybook", member_type: "user", member_id: "alice", role: "admin", added_at: 2 },
      { group_id: "product", group_name: "Product", channel_id: "responsive", channel_name: "responsive-web", member_type: "user", member_id: "alice", role: "member", added_at: 3 },
    ] },
  } },
} satisfies Meta<typeof PeopleScreen>;

export default meta;
type Story = StoryObj<typeof meta>;
export const MembershipDirectory: Story = {};
