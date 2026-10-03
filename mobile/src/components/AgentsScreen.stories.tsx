import type { Meta, StoryObj } from "@storybook/react-native";
import AgentsScreen from "../../app/(app)/agents";
import { useSession } from "../state/session";
const meta = {
  title: "Native/Screens/Agents",
  component: AgentsScreen,
} satisfies Meta<typeof AgentsScreen>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Populated: Story = {};
export const EmptyMember: Story = { parameters: {
  setup: () => useSession.setState({ instanceAdmin: false }),
  apiRoutes: { "GET /api/agents": { agents: [] } },
} };
