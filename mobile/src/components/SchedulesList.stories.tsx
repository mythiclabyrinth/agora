import type { Meta, StoryObj } from "@storybook/react-native";
import { fixtureSchedules } from "@agora/core/testing/fixtures";
import { SchedulesList, ScheduleTimeSheet } from "./SchedulesList";

const meta = {
  title: "Native/Screens/Schedules",
  component: SchedulesList,
  args: { channelId: "general", threadId: null, onOpen: () => {} },
  parameters: { apiRoutes: { "GET /api/channels/general/schedules": { items: fixtureSchedules } } },
} satisfies Meta<typeof SchedulesList>;

export default meta;
type Story = StoryObj<typeof meta>;
/** A thread loop (weekday cron), a 6-hourly watchdog, and a paused one-off whose owner lost access. */
export const ChannelSchedules: Story = {};
export const ThreadSchedules: Story = {
  args: { threadId: 42 },
  parameters: { apiRoutes: { "GET /api/channels/general/schedules?thread_id=42": { items: [fixtureSchedules[0]] } } },
};
export const ReadOnly: Story = {
  parameters: { apiRoutes: { "GET /api/channels/general/schedules": { items: fixtureSchedules.map(item => ({ ...item, can_manage: false })) } } },
};
export const Empty: Story = {
  parameters: { apiRoutes: { "GET /api/channels/general/schedules": { items: [] } } },
};

/** Long prompts remain readable without squeezing the schedule controls. */
export const LongMessage: Story = {
  parameters: { apiRoutes: { "GET /api/channels/general/schedules": { items: [{ ...fixtureSchedules[0],
    text: "Review the release checks and report any blockers.\n".repeat(12),
  }] } } },
};

export const Completed: Story = {
  parameters: { apiRoutes: { "GET /api/channels/general/schedules": { items: [{ ...fixtureSchedules[0],
    status: "done", next_runs: [], can_manage: false,
  }] } } },
};

export const TimeEditor: Story = {
  render: () => <ScheduleTimeSheet item={fixtureSchedules[0]} onClose={() => {}} />,
};
