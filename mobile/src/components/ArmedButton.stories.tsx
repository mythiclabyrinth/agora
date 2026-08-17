import type { Meta, StoryObj } from "@storybook/react-native";
import { ArmedButton } from "./ArmedButton";

const meta = {
  title: "Native/Atoms/Armed button",
  component: ArmedButton,
  args: {
    label: "Remove agent",
    armedLabel: "Tap again to remove",
    onConfirm: () => {},
  },
} satisfies Meta<typeof ArmedButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Compact: Story = {
  args: { label: "Remove", armedLabel: "Sure?", compact: true },
};
