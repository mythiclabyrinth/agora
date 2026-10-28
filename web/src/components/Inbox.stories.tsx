import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { fixtureGroups, fixtureMe, fixtureSchedules, fixtureThreads } from "@agora/core/testing/fixtures";
import { useMessageDrafts, type DraftRow, type UnreadItem } from "@agora/core";
import { Inbox } from "./Inbox";
import { useUiState } from "../state/ui";
import { inboxPathAfterReload } from "../lib/inboxReload";

const now = Date.now() / 1000;
const channel: UnreadItem = {
  kind: "channel", channel_id: "general", channel_name: "general", group_id: "product", group_name: "Product",
  thread_id: null, title: null, unread: 2, mentions: 0, first_unread_id: 44, ack_through_id: 45,
  latest_ts: now, previews: [
    { ...fixtureThreads[0].root, id: 44, text: "The build is ready to check", thread_id: null },
    { ...fixtureThreads[0].root, id: 45, text: "Please review the result", thread_id: null },
  ],
};
const thread: UnreadItem = {
  ...channel, kind: "thread", thread_id: 42, title: "Launch planning", unread: 1,
  mentions: 1, first_unread_id: 46, ack_through_id: 46,
  previews: [{ ...fixtureThreads[0].root, id: 46, text: "@tom could you review?", thread_id: 42 }],
};
const draft: DraftRow = { channel_id: "general", thread_id: null, body: "Review before sending", meta: { addressed: [], reply_in_thread: false }, rev: 1, client_id: "other", updated_at: now, channel_name: "general", group_id: "product", group_name: "Product", thread_title: null };

const meta = {
  title: "Web/Connected/Inbox",
  component: Inbox,
  parameters: {
    apiRoutes: {
      "GET /api/me": { ...fixtureMe, drafts_sync: true },
      "GET /api/groups": { groups: fixtureGroups },
      "GET /api/threads?limit=100": { threads: fixtureThreads },
      "GET /api/unreads": { items: [thread, channel], total: 2 },
      "GET /api/approvals": { items: [], total: 0 },
      "GET /api/drafts": { items: [draft], total: 1 },
      "PUT /api/unreads/read": { ok: true, marked: 1 },
    },
    setup: () => history.replaceState(null, "", "/inbox/unreads"),
  },
} satisfies Meta<typeof Inbox>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText(/Launch planning in/)).resolves.toBeVisible();
    await userEvent.click(canvas.getByRole("tab", { name: "Threads" }));
    expect(useUiState.getState().inboxTab).toBe("threads");
    await expect(canvas.findByText("Can we validate the responsive component layout?")).resolves.toBeVisible();
    await userEvent.click(canvas.getByRole("tab", { name: /Unreads/ }));
    expect(useUiState.getState().inboxTab).toBe("unreads");
    await userEvent.click(canvas.getByRole("button", { name: "@Mentions" }));
    expect(useUiState.getState().inboxFilter).toBe("mentions");
    await userEvent.click(canvas.getByRole("button", { name: "Mark thread read" }));
  },
};

export const Empty: Story = { parameters: { apiRoutes: { "GET /api/unreads": { items: [], total: 0 } }, setup: () => history.replaceState(null, "", "/inbox/unreads") } };
export const Limited: Story = { parameters: {
  apiRoutes: { "GET /api/unreads": { items: [thread, channel], total: 245 } },
  setup: () => history.replaceState(null, "", "/inbox/unreads"),
} };
export const Mentions: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "@Mentions" }));
    await expect(canvas.findByText(/Launch planning in/)).resolves.toBeVisible();
    await expect(canvas.queryByText("The build is ready to check")).toBeNull();
  },
};
export const Threads: Story = { parameters: { setup: () => history.replaceState(null, "", "/inbox/threads") } };
export const Approvals: Story = { parameters: { setup: () => history.replaceState(null, "", "/inbox/approvals") } };
export const Drafts: Story = { parameters: { setup: () => {
  useMessageDrafts.getState().setRows([draft]);
  history.replaceState(null, "", "/inbox/drafts");
} }, play: async ({ canvasElement }) => {
  await expect(within(canvasElement).findByRole("tab", { name: "Drafts (1)" })).resolves.toBeVisible();
} };
export const Schedules: Story = {
  parameters: {
    apiRoutes: { ...meta.parameters.apiRoutes, "GET /api/schedules": { items: fixtureSchedules } },
    setup: () => history.replaceState(null, "", "/inbox/schedules"),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByRole("tab", { name: "Schedules" })).resolves.toHaveAttribute("aria-selected", "true");
    await expect(canvas.findByText("Weekdays at 07:00 UTC")).resolves.toBeVisible();
    // No channel headings: each card names its channel (and thread).
    expect(canvas.queryAllByRole("region", { name: /^Schedules in / })).toHaveLength(0);
    await expect(canvas.findByText("#storybook · Product › Responsive layout loop")).resolves.toBeVisible();
  },
};
// One flat list across channels, soonest next run first on every tab
// (paused rows by when resuming would run), each card labelled.
const mixedRow = (id: string, channel: string, status: "active" | "paused", runAt: number) => ({
  ...fixtureSchedules[1], id, channel_id: channel, channel_name: channel, group_id: "product", thread_id: null, thread_title: null,
  status, run_at: runAt, next_runs: [runAt], can_manage: false,
});
export const SchedulesFlatByNextRun: Story = {
  parameters: {
    apiRoutes: { ...meta.parameters.apiRoutes, "GET /api/schedules": { items: [
      mixedRow("a-act", "alpha", "active", 300), mixedRow("s-act", "storybook", "active", 100),
      mixedRow("a-pau", "alpha", "paused", 200), mixedRow("s-pau", "storybook", "paused", 400),
    ] } },
    setup: () => history.replaceState(null, "", "/inbox/schedules"),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const ids = () => [...canvasElement.querySelectorAll("[data-schedule-id]")].map(r => r.getAttribute("data-schedule-id"));
    await waitFor(() => expect(ids()).toEqual(["s-act", "a-pau", "a-act", "s-pau"]));
    expect([...canvasElement.querySelectorAll(".ago-sched-where")].map(e => e.textContent?.trim()))
      .toEqual(["#storybook · Product", "#alpha · Product", "#alpha · Product", "#storybook · Product"]);
    expect(canvas.queryAllByRole("region", { name: /^Schedules in / })).toHaveLength(0);
    await userEvent.click(await canvas.findByRole("tab", { name: /^Active/ }));
    await waitFor(() => expect(ids()).toEqual(["s-act", "a-act"]));
    await userEvent.click(await canvas.findByRole("tab", { name: /^Paused/ }));
    await waitFor(() => expect(ids()).toEqual(["a-pau", "s-pau"]));
  },
};

// Phone width: where, then when, stacked on top; the status pill bottom
// right inside the card; nothing spills past the card.
export const SchedulesPhoneCard: Story = {
  parameters: Schedules.parameters,
  globals: { viewport: { value: "phone", isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvasElement.ownerDocument.defaultView!.innerWidth).toBeLessThanOrEqual(640);
    await canvas.findByText("#storybook · Product › Responsive layout loop");
    for (const card of canvasElement.querySelectorAll<HTMLElement>(".ago-sched-row")) {
      const box = card.getBoundingClientRect();
      const where = card.querySelector(".ago-sched-where")!.getBoundingClientRect();
      const when = card.querySelector(".ago-sched-cadence")!.getBoundingClientRect();
      const pill = card.querySelector(".ago-sched-status")!.getBoundingClientRect();
      expect(when.top).toBeGreaterThanOrEqual(where.bottom - 1);
      expect(pill.right).toBeLessThanOrEqual(box.right);
      expect(box.right - pill.right).toBeLessThan(24);
      expect(box.bottom - pill.bottom).toBeLessThan(24);
      expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
    }
  },
};

// Agent DMs come back with group_id "" — opening one must still navigate,
// landing on the synthetic DMs group rather than silently doing nothing.
export const SchedulesInAgentDm: Story = {
  parameters: {
    apiRoutes: {
      ...meta.parameters.apiRoutes,
      "GET /api/schedules": { items: [{
        ...fixtureSchedules[1], id: "sch-dm", channel_id: "dm-claude", channel_name: "Claude",
        channel_kind: "agent_dm", group_id: "", thread_id: null, thread_title: null,
      }] },
    },
    setup: () => history.replaceState(null, "", "/inbox/schedules"),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /Claude/ }));
    await expect(useUiState.getState().sel).toEqual({ g: "__dms", c: "dm-claude" });
  },
};
export const SchedulesOwnerLostChannel: Story = {
  parameters: {
    apiRoutes: {
      ...meta.parameters.apiRoutes,
      "GET /api/schedules": { items: [{
        ...fixtureSchedules[1], id: "sch-lost", channel_id: "ops", channel_name: "ops",
        thread_id: 42, thread_title: "old thread", can_manage: true, is_owner: true, channel_access: false,
      }] },
    },
    setup: () => history.replaceState(null, "", "/inbox/schedules"),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Still labelled, but not a link: the owner can't open that channel.
    await expect(canvas.findByText("#ops · Product › old thread")).resolves.toBeVisible();
    expect(canvas.queryByRole("button", { name: /#ops/ })).toBeNull();
    // No "open conversation" link into a channel the owner can't load.
    await expect(canvas.queryByTitle("Open conversation")).toBeNull();
    await expect(canvas.findByText(/no longer have access/i)).resolves.toBeTruthy();
  },
};
export const DraftsOnOlderServer: Story = {
  parameters: {
    apiRoutes: { ...meta.parameters.apiRoutes, "GET /api/me": { ...fixtureMe, drafts_sync: false } },
    setup: () => history.replaceState(null, "", "/inbox/drafts"),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByRole("tab", { name: /Unreads/ })).resolves.toHaveAttribute("aria-selected", "true");
    expect(canvas.queryByRole("tab", { name: /Drafts/ })).toBeNull();
  },
};

export const RememberedTab: Story = {
  play: async () => {
    useUiState.getState().setInboxTab("threads");
    history.replaceState(null, "", "/inbox/unreads");
    useUiState.getState().openInbox("replace");
    expect(window.location.pathname).toBe("/inbox/threads");
  },
};

export const ReloadResetRules: Story = {
  play: async () => {
    expect(inboxPathAfterReload("/inbox/threads", "reload", {})).toBe("/inbox/unreads");
    expect(inboxPathAfterReload("/inbox/approvals", "reload", {})).toBe("/inbox/unreads");
    expect(inboxPathAfterReload("/inbox/schedules", "reload", {})).toBe("/inbox/unreads");
    expect(inboxPathAfterReload("/inbox/threads", "reload", null)).toBeNull();
    expect(inboxPathAfterReload("/inbox/threads", "navigate", {})).toBeNull();
    expect(inboxPathAfterReload("/inbox/unreads", "reload", {})).toBeNull();
  },
};

// The inbox's Done tab is strictly latest run first: one flat list, each
// row labelled with its channel and group.
const doneRow = (id: string, channel: string, updatedAt: number) => ({
  ...fixtureSchedules[1], id, channel_id: channel, channel_name: channel, group_id: "product", thread_id: null, thread_title: null,
  status: "done" as const, updated_at: updatedAt, last_run_at: updatedAt, next_runs: [], can_manage: false,
});
export const SchedulesDoneTab: Story = {
  parameters: {
    apiRoutes: {
      ...meta.parameters.apiRoutes,
      "GET /api/schedules": { items: fixtureSchedules },
      "GET /api/schedules?status=done": { items: [
        doneRow("z1", "zeta", 300), doneRow("a1", "alpha", 200), doneRow("z2", "zeta", 100),
        // Agent DMs carry group_id "": still labelled with the DMs group.
        { ...doneRow("dm1", "Claude", 50), channel_kind: "agent_dm", group_id: "" },
        // No channel name from the server: labelled by its id.
        { ...doneRow("nn1", "nameless-7f2a", 40), channel_name: null },
      ], truncated: true },
    },
    setup: () => history.replaceState(null, "", "/inbox/schedules"),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("tab", { name: "Done" }));
    // The server capped the list (truncated): the badge says there are more.
    await expect(canvas.findByRole("tab", { name: "Done 5+" })).resolves.toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect([...canvasElement.querySelectorAll("[data-schedule-id]")].map(r => r.getAttribute("data-schedule-id")))
      .toEqual(["z1", "a1", "z2", "dm1", "nn1"]));
    expect(canvas.queryAllByRole("region", { name: /^Schedules in / })).toHaveLength(0);
    expect([...canvasElement.querySelectorAll(".ago-sched-where")].map(e => e.textContent?.trim()))
      .toEqual(["#zeta · Product", "#alpha · Product", "#zeta · Product", "Claude · Direct messages", "#nameless-7f2a · Product"]);
    await expect(canvas.findByText(/most recently finished/)).resolves.toBeVisible();
  },
};

export const ScheduleStatusFilters: Story = {
  parameters: Schedules.parameters,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const filters = within(await canvas.findByRole("tablist", { name: "Schedule status" }));
    await userEvent.click(filters.getByRole("tab", { name: "Paused 1" }));
    await expect(canvas.findByText("@cursor weekly dependency report")).resolves.toBeVisible();
    expect(canvas.queryByText("Every 6 hours")).toBeNull();
    await userEvent.click(filters.getByRole("tab", { name: "Active 2" }));
    await expect(canvas.findByText("Every 6 hours")).resolves.toBeVisible();
    expect(canvas.queryByText("@cursor weekly dependency report")).toBeNull();
  },
};
