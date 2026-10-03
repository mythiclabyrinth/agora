import type { Meta, StoryObj } from "@storybook/react-native";
import { CheckCheck, Search, WifiOff } from "lucide-react-native";
import { fn } from "storybook/test";
import { EmptyState } from "./EmptyState";

const meta = { title: "Native/Atoms/Empty state", component: EmptyState,
  args: { icon: CheckCheck, title: "You're all caught up",
    description: "New messages will appear here." },
} satisfies Meta<typeof EmptyState>;
export default meta;
type Story = StoryObj<typeof meta>;
export const CaughtUp: Story = {};
export const NoResults: Story = { args: { icon: Search, title: "No messages found",
  description: "Try another search or change your filters." } };
export const Error: Story = { args: { icon: WifiOff, title: "Couldn't load messages",
  description: "Check your connection and try again.", action: { label: "Retry", onPress: fn() } } };
export const Retrying: Story = { args: { ...Error.args,
  action: { label: "Retrying…", onPress: fn(), disabled: true } } };
