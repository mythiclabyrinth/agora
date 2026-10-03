import type { Meta, StoryObj } from "@storybook/react-native";
import { fn } from "storybook/test";
import { SheetHeader } from "./SheetHeader";
const meta = { title: "Native/Atoms/Sheet header", component: SheetHeader,
  args: { title: "Pinned messages", onClose: fn() },
} satisfies Meta<typeof SheetHeader>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Pins: Story = {};
export const Attachments: Story = { args: { title: "Add attachment" } };
