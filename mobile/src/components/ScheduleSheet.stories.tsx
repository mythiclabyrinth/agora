import type { Meta, StoryObj } from "@storybook/react-native";
import { fn } from "storybook/test";
import { ScheduleSheet } from "./ScheduleSheet";

/* Long-press Send in the composer opens this. Tap "Custom time" for the
   date-time spinner (iOS) or the date and time fields (Android). */
const meta = {
  title: "Native/Composer/Schedule sheet",
  component: ScheduleSheet,
  args: {
    visible: true,
    presets: [60, 180],
    pending: false,
    onClose: fn(),
    onSchedule: fn(),
  },
} satisfies Meta<typeof ScheduleSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** AGORA_SCHEDULE_PRESETS=30,90,1440 */
export const ConfiguredPresets: Story = { args: { presets: [30, 90, 1440] } };

export const Scheduling: Story = { args: { pending: true } };
