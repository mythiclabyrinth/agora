import type { Meta, StoryObj } from "@storybook/react-native";
import { fixtureMe } from "@agora/core/testing/fixtures";
import SettingsScreen from "../../app/(app)/settings";
import { useSession } from "../state/session";

const meta = {
  title: "Native/Screens/Settings",
  component: SettingsScreen,
  parameters: { apiRoutes: {
    "PATCH /api/me": { ...fixtureMe, display_name: "Updated name" },
  } },
} satisfies Meta<typeof SettingsScreen>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Member: Story = {
  parameters: { setup: () => useSession.setState({ instanceAdmin: false }),
    apiRoutes: { "GET /api/me": { ...fixtureMe, instance_admin: false } } },
};
export const Admin: Story = {
  parameters: { setup: () => useSession.setState({ instanceAdmin: true }) },
};
