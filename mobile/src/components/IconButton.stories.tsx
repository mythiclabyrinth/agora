import type { Meta, StoryObj } from "@storybook/react-native";
import { Search } from "lucide-react-native";
import { fn } from "storybook/test";
import { IconButton } from "./IconButton";

const meta = { title: "Native/Atoms/Icon button", component: IconButton,
  args: { icon: Search, accessibilityLabel: "Search messages", onPress: fn() },
} satisfies Meta<typeof IconButton>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Selected: Story = { args: { selected: true } };
export const Disabled: Story = { args: { disabled: true } };
export const Busy: Story = { args: { busy: true } };
