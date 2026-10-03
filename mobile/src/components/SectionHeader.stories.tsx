import type { Meta, StoryObj } from "@storybook/react-native";
import { Plus } from "lucide-react-native";
import { fn } from "storybook/test";
import { SectionHeader } from "./SectionHeader";
import { IconButton } from "./IconButton";

const meta = { title: "Native/Atoms/Section header", component: SectionHeader,
  args: { title: "Product", subtitle: "Conversations with your team and agents" },
} satisfies Meta<typeof SectionHeader>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const WithAction: Story = { args: { action:
  <IconButton icon={Plus} accessibilityLabel="Create channel" onPress={fn()} /> } };
export const LongTitle: Story = { args: {
  title: "Research, product strategy and customer conversations",
  subtitle: "Long group names remain readable without hiding the action.",
  action: <IconButton icon={Plus} accessibilityLabel="Create channel" onPress={fn()} />,
} };
