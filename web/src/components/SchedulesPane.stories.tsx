import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { SCHEDULE_OFFLINE_AGENT_ERROR } from "@agora/core";
import { fixtureGroups, fixtureSchedules } from "@agora/core/testing/fixtures";
import { useUiState } from "../state/ui";
import { SchedulesPane } from "./SchedulesPane";

const [loop, watchdog, paused] = fixtureSchedules;
const patched = fn((body: unknown) => ({ schedule: { ...watchdog, ...(body as object) } }));
const cancelled = fn(() => ({ ok: true }));

const meta = {
  title: "Web/Connected/Schedules pane",
  component: SchedulesPane,
  parameters: {
    apiRoutes: {
      "GET /api/groups": { groups: fixtureGroups },
      "GET /api/channels/general/schedules": { items: fixtureSchedules },
      "GET /api/channels/general/schedules?thread_id=42": { items: [loop] },
      "PATCH /api/schedules/sch-watchdog": patched,
      "PATCH /api/schedules/sch-loop": patched,
      "DELETE /api/schedules/sch-watchdog": cancelled,
    },
    setup: () => useUiState.setState({
      sel: { g: "product", c: "general" }, schedulesOpen: true, schedulesThread: null,
      filesOpen: false, membersOpen: false,
    }),
    layout: "centered",
  },
} satisfies Meta<typeof SchedulesPane>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Channel: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("Weekdays at 07:00 UTC")).resolves.toBeVisible();
    await expect(canvas.findByText("Every 6 hours")).resolves.toBeVisible();
    // Thread schedules are labelled with their thread in the channel view.
    await expect(canvas.findByText(/Responsive layout loop/)).resolves.toBeVisible();
    await expect(canvas.findByText(/via claude-cli/)).resolves.toBeVisible();
    const row = canvasElement.querySelector<HTMLElement>('[data-schedule-id="sch-watchdog"]')!;
    await userEvent.click(within(row).getByRole("button", { name: /Pause/ }));
    await expect(patched).toHaveBeenCalledWith({ status: "paused" });
    await userEvent.click(within(row).getByRole("button", { name: /Cancel/ }));
    await expect(within(row).findByRole("button", { name: /Cancel it\?/ })).resolves.toBeVisible();
    await userEvent.click(within(row).getByRole("button", { name: /Cancel it\?/ }));
    await expect(cancelled).toHaveBeenCalled();
  },
};

export const OpeningAThreadKeepsThePane: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const label = await canvas.findByRole("button", { name: /Responsive layout loop/ });
    await userEvent.click(label);
    // The thread opened, and the pane stayed, now scoped to that thread.
    await expect(useUiState.getState().threadRoot).toBe(42);
    await expect(useUiState.getState().schedulesOpen).toBe(true);
    await expect(useUiState.getState().schedulesThread).toBe(42);
    await expect(canvas.findByText("this thread")).resolves.toBeVisible();
  },
};

export const ChangeTime: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Every 6 hours");
    const row = canvasElement.querySelector<HTMLElement>('[data-schedule-id="sch-watchdog"]')!;
    await userEvent.click(within(row).getByRole("button", { name: /Change time/ }));
    await userEvent.click(within(row).getByText("Cron"));
    const rule = within(row).getByLabelText("Cron rule");
    await userEvent.clear(rule);
    await userEvent.type(rule, "30 6 * * 1-5");
    await expect(within(row).findByText(/Weekdays at 06:30 UTC/)).resolves.toBeVisible();
    await userEvent.click(within(row).getByRole("button", { name: "Save" }));
    await expect(patched).toHaveBeenCalledWith({ schedule: { kind: "cron", expr: "30 6 * * 1-5" } });
  },
};

// The owner can also move a repeating schedule's next run.
export const OwnerMovesNextRun: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Every 6 hours");
    const row = canvasElement.querySelector<HTMLElement>('[data-schedule-id="sch-watchdog"]')!;
    await userEvent.click(within(row).getByRole("button", { name: /Change time/ }));
    const next = new Date(Date.now() + 3 * 86_400_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const value = `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}T03:00`;
    const field = within(row).getByLabelText("Next run");
    await userEvent.type(field, value);
    await userEvent.click(within(row).getByRole("button", { name: "Save" }));
    // The rule itself is untouched, so only the new next run is sent.
    await expect(patched).toHaveBeenCalledWith({ run_at: Math.round(new Date(value).getTime() / 1000) });
  },
};

// Saving the editor without edits must not re-send the rule (which would
// restart the clock and undo a postponed next run) or a seconds-less time.
export const SaveWithoutEditsSendsNothing: Story = {
  play: async ({ canvasElement }) => {
    patched.mockClear();
    const canvas = within(canvasElement);
    await canvas.findByText("Every 6 hours");
    const row = canvasElement.querySelector<HTMLElement>('[data-schedule-id="sch-watchdog"]')!;
    await userEvent.click(within(row).getByRole("button", { name: /Change time/ }));
    await userEvent.click(within(row).getByRole("button", { name: "Save" }));
    await expect(within(row).queryByRole("button", { name: "Save" })).toBeNull();
    await expect(patched).not.toHaveBeenCalled();
  },
};

export const ThreadOnly: Story = {
  parameters: { setup: () => useUiState.setState({
    sel: { g: "product", c: "general" }, schedulesOpen: true, schedulesThread: 42,
  }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("this thread")).resolves.toBeVisible();
    await expect(canvas.findByText("Weekdays at 07:00 UTC")).resolves.toBeVisible();
    expect(canvas.queryByText("Every 6 hours")).toBeNull();
    expect(canvas.queryByText(/Responsive layout loop/)).toBeNull();
  },
};

export const PausedWithErrorReadOnly: Story = {
  parameters: { apiRoutes: { ...meta.parameters.apiRoutes, "GET /api/channels/general/schedules": { items: [paused] } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("alice can no longer post in #storybook")).resolves.toBeVisible();
    await expect(canvasElement.querySelector(".ago-sched-status.paused")).toHaveTextContent("Paused");
    // Not the owner or an admin: no controls.
    expect(canvas.queryByRole("button", { name: /Resume/ })).toBeNull();
    expect(canvas.queryByRole("button", { name: /Change time/ })).toBeNull();
  },
};

export const CappedListSaysSo: Story = {
  parameters: { apiRoutes: { ...meta.parameters.apiRoutes, "GET /api/channels/general/schedules": { items: [paused], truncated: true } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByRole("status")).resolves.toHaveTextContent("Showing the 1,000 soonest schedules");
  },
};

export const PausedPreviewsResume: Story = {
  parameters: { apiRoutes: { ...meta.parameters.apiRoutes, "GET /api/channels/general/schedules": { items: [paused] } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // A paused schedule's times are what resuming would schedule, so say so.
    await expect(canvas.findByText(/^If resumed:/)).resolves.toBeVisible();
    expect(canvas.queryByText(/^Next:/)).toBeNull();
  },
};

export const OwnerLostTheChannel: Story = {
  parameters: { apiRoutes: { ...meta.parameters.apiRoutes, "GET /api/channels/general/schedules": {
    items: [{ ...watchdog, can_manage: true, is_owner: true, channel_access: false }],
  } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("You no longer have access to this channel")).resolves.toBeVisible();
    const row = canvasElement.querySelector<HTMLElement>('[data-schedule-id="sch-watchdog"]')!;
    // Pause or Cancel only: nothing that would post into a channel they can't see.
    await expect(within(row).findByRole("button", { name: /Pause/ })).resolves.toBeVisible();
    expect(within(row).queryByRole("button", { name: /Resume/ })).toBeNull();
    expect(within(row).queryByRole("button", { name: /Change time/ })).toBeNull();
    await userEvent.click(within(row).getByRole("button", { name: /Cancel/ }));
    await userEvent.click(within(row).getByRole("button", { name: /Cancel it\?/ }));
    await expect(cancelled).toHaveBeenCalled();
  },
};

export const AdminRetimesSomeoneElses: Story = {
  parameters: { apiRoutes: { ...meta.parameters.apiRoutes, "GET /api/channels/general/schedules": {
    items: [{ ...paused, id: "sch-watchdog", status: "active", last_error: null, can_manage: true, is_owner: false }],
  } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const row = await canvas.findByText("@cursor weekly dependency report")
      .then(el => el.closest<HTMLElement>("[data-schedule-id]")!);
    await userEvent.click(within(row).getByRole("button", { name: /Change time/ }));
    // Only the owner changes how often; an admin gets just the next time.
    expect(within(row).queryByRole("radiogroup", { name: "Repeat" })).toBeNull();
    await expect(within(row).findByText(/Only Alice can change how often/)).resolves.toBeVisible();
    const later = new Date(Date.now() + 4 * 86_400_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const value = `${later.getFullYear()}-${pad(later.getMonth() + 1)}-${pad(later.getDate())}T09:00`;
    const field = within(row).getByLabelText("Next run");
    await userEvent.clear(field);
    await userEvent.type(field, value);
    await userEvent.click(within(row).getByRole("button", { name: "Save" }));
    await expect(patched).toHaveBeenCalledWith({ run_at: Math.round(new Date(value).getTime() / 1000) });
  },
};

// A re-armed one-off: the editor starts from its live next run, not a stale spec time.
export const ReArmedOneOffStartsFromNextRun: Story = {
  parameters: { apiRoutes: { ...meta.parameters.apiRoutes, "GET /api/channels/general/schedules": {
    items: [{ ...paused, id: "sch-loop", status: "active", last_error: null, can_manage: true, is_owner: true,
      schedule: { kind: "once", at: 1_750_000_000 }, run_at: 1_750_200_000, next_runs: [1_750_200_000] }],
  } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const row = await canvas.findByText("@cursor weekly dependency report")
      .then(el => el.closest<HTMLElement>("[data-schedule-id]")!);
    await userEvent.click(within(row).getByRole("button", { name: /Change time/ }));
    const d = new Date(1_750_200_000 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const expected = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    await expect(within(row).getByLabelText("Run at")).toHaveValue(expected);
  },
};

export const Empty: Story = {
  parameters: { apiRoutes: { ...meta.parameters.apiRoutes, "GET /api/channels/general/schedules": { items: [] } } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).findByText(/Ask an agent to schedule a message/)).resolves.toBeVisible();
  },
};

export const LongMessage: Story = {
  parameters: { apiRoutes: { ...meta.parameters.apiRoutes, "GET /api/channels/general/schedules": {
    items: [{ ...watchdog, text: "Review the release checks and report any blockers.\n".repeat(12) }],
  } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const expand = await canvas.findByRole("button", { name: "Read full message" });
    await userEvent.click(expand);
    await expect(canvas.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(canvas.getByText("Later runs"));
    await expect(canvasElement.querySelector("details")).toHaveAttribute("open");
  },
};

export const StatusTabs: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tabs = within(await canvas.findByRole("tablist", { name: "Schedule status" }));
    await expect(tabs.getByRole("tab", { name: "All 3" })).toHaveAttribute("aria-selected", "true");
    const active = tabs.getByRole("tab", { name: "Active 2" });
    await userEvent.click(active);
    await expect(active).toHaveAttribute("aria-selected", "true");
    expect(canvas.queryByText("@cursor weekly dependency report")).toBeNull();
    await userEvent.keyboard("{ArrowRight}");
    await expect(tabs.getByRole("tab", { name: "Paused 1" })).toHaveFocus();
    await expect(canvas.findByText("@cursor weekly dependency report")).resolves.toBeVisible();
    expect(canvas.queryByText("Every 6 hours")).toBeNull();
    await userEvent.keyboard("{Home}");
    await expect(tabs.getByRole("tab", { name: "All 3" })).toHaveFocus();
    await expect(canvas.findByText("Every 6 hours")).resolves.toBeVisible();
  },
};
export const ActiveTab: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole("tab", { name: "Active 2" }));
  },
};
export const PausedTab: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole("tab", { name: "Paused 1" }));
  },
};
export const EmptyStatusTabs: Story = {
  parameters: Empty.parameters,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("tab", { name: "Active" }));
    await expect(canvas.findByText("No active schedules")).resolves.toBeVisible();
    await userEvent.click(canvas.getByRole("tab", { name: "Paused" }));
    await expect(canvas.findByText("No paused schedules")).resolves.toBeVisible();
  },
};
export const ActiveDeliveryError: Story = {
  parameters: { apiRoutes: { ...meta.parameters.apiRoutes, "GET /api/channels/general/schedules": { items: [{ ...watchdog,
    last_error: SCHEDULE_OFFLINE_AGENT_ERROR,
  }] } } },
};

/** Stable overview for light/dark and narrow-width visual checks. */
export const FilterOverview: Story = {};
