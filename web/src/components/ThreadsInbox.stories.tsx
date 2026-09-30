import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import {
  fixtureGroups,
  fixtureMe,
  fixtureThreads,
} from "@agora/core/testing/fixtures";
import { normalizeSelection, useUiState } from "../state/ui";
import { ThreadsInbox } from "./ThreadsInbox";

const root = fixtureThreads[0].root;
const now = Math.floor(Date.now() / 1000);
const tabletReplyDate = new Date(now * 1000);
tabletReplyDate.setDate(tabletReplyDate.getDate() - 3);
tabletReplyDate.setHours(12, 4, 0, 0);
const inboxThreads = [
  { ...fixtureThreads[0], root: { ...root, id: 42, alias: "Zulu planning" }, last_reply_ts: now - 300 },
  { ...fixtureThreads[0], root: { ...root, id: 43, alias: null, text: "Alpha launch notes" }, last_reply_ts: now - 3600 },
  { ...fixtureThreads[0], root: { ...root, id: 44, alias: "Bravo review" }, last_reply_ts: now - 86400 * 3 },
  { ...fixtureThreads[0], root: { ...root, id: 45, alias: null, text: "Charlie follow-up" }, last_reply_ts: now - 86400 * 10 },
];
const groupThreads = inboxThreads.map((thread, index) => index < 2 ? thread : {
  ...thread, group_id: "design", group_name: "Design",
});
const groups = [...fixtureGroups, { ...fixtureGroups[0], id: "design", name: "Design" }];

const dmThread = {
  ...fixtureThreads[0],
  root: { ...root, id: 10897, alias: "Private agent thread" },
  channel_id: "claude-m5-5b85",
  channel_name: "Claude M5",
  group_id: "__dms",
  group_name: "Direct messages",
};

function rowNames(canvasElement: HTMLElement): string[] {
  return [...canvasElement.querySelectorAll<HTMLElement>(".ago-inbox-row .snippet")]
    .map(element => element.textContent || "");
}

const meta = {
  title: "Web/Connected/Threads inbox",
  component: ThreadsInbox,
  parameters: {
    apiRoutes: {
      "GET /api/me": fixtureMe,
      "GET /api/groups": { groups: fixtureGroups },
      "GET /api/threads?limit=100": { threads: fixtureThreads },
    },
    setup: () => useUiState.setState({ view: { kind: "inbox" }, mobileView: "main" }),
  },
} satisfies Meta<typeof ThreadsInbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const UnreadThread: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("1")).resolves.toBeVisible();
    await userEvent.click(canvas.getByText("Can we validate the responsive component layout?"));
    expect(useUiState.getState().threadRoot).toBe(42);
    expect(useUiState.getState().sel).toEqual({ g: "product", c: "general" });
  },
};

export const AgentDirectMessageThread: Story = {
  parameters: {
    apiRoutes: {
      "GET /api/me": fixtureMe,
      "GET /api/groups": { groups: fixtureGroups },
      "GET /api/threads?limit=100": { threads: [dmThread] },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByText("Private agent thread"));
    expect(useUiState.getState().sel).toEqual({ g: "__dms", c: "claude-m5-5b85" });
    expect(useUiState.getState().threadRoot).toBe(10897);
    expect(window.location.pathname).toMatch(/\/g\/__dms\/c\/claude-m5-5b85\/t\/10897$/);

    useUiState.getState().closeThread("replace");
    expect(window.location.pathname).toMatch(/\/g\/__dms\/c\/claude-m5-5b85$/);
    expect(normalizeSelection({ g: "", c: "claude-m5-5b85" }))
      .toEqual({ g: "__dms", c: "claude-m5-5b85" });

    useUiState.getState().selectChannel("", "claude-m5-5b85", "replace");
    expect(useUiState.getState().sel).toEqual({ g: "__dms", c: "claude-m5-5b85" });
    useUiState.getState().openThread(10897, "replace");
    expect(window.location.pathname).toMatch(/\/g\/__dms\/c\/claude-m5-5b85\/t\/10897$/);
  },
};

export const Empty: Story = {
  parameters: {
    apiRoutes: {
      "GET /api/me": fixtureMe,
      "GET /api/groups": { groups: fixtureGroups },
      "GET /api/threads?limit=100": { threads: [] },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).findByText("No threads yet")).resolves.toBeVisible();
  },
};

export const SortFilterAndPersistence: Story = {
  parameters: {
    apiRoutes: {
      "GET /api/me": fixtureMe,
      "GET /api/groups": { groups: fixtureGroups },
      "GET /api/threads?limit=100": { threads: inboxThreads },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Zulu planning");
    expect(rowNames(canvasElement)).toEqual([
      "Zulu planning", "Alpha launch notes", "Bravo review", "Charlie follow-up",
    ]);

    await userEvent.selectOptions(canvas.getByLabelText("Sort threads"), "oldest");
    expect(rowNames(canvasElement)).toEqual([
      "Charlie follow-up", "Bravo review", "Alpha launch notes", "Zulu planning",
    ]);
    await userEvent.selectOptions(canvas.getByLabelText("Sort threads"), "az");
    expect(rowNames(canvasElement)).toEqual([
      "Alpha launch notes", "Bravo review", "Charlie follow-up", "Zulu planning",
    ]);
    await userEvent.selectOptions(canvas.getByLabelText("Sort threads"), "za");
    expect(rowNames(canvasElement)).toEqual([
      "Zulu planning", "Charlie follow-up", "Bravo review", "Alpha launch notes",
    ]);

    await userEvent.selectOptions(canvas.getByLabelText("Filter threads"), "saved");
    expect(rowNames(canvasElement)).toEqual(["Zulu planning", "Bravo review"]);
    expect(localStorage.getItem("agora_threads_sort")).toBe("za");
    expect(localStorage.getItem("agora_threads_filter")).toBe("saved");

    useUiState.setState({ threadsSort: "recent", threadsFilter: "all" });
    useUiState.setState({
      threadsSort: localStorage.getItem("agora_threads_sort") as "za",
      threadsFilter: localStorage.getItem("agora_threads_filter") as "saved",
    });
    await waitFor(() => expect(rowNames(canvasElement)).toEqual(["Zulu planning", "Bravo review"]));

    await userEvent.selectOptions(canvas.getByLabelText("Filter threads"), "unset");
    expect(rowNames(canvasElement)).toEqual(["Charlie follow-up", "Alpha launch notes"]);
  },
};

export const GroupFilter: Story = {
  parameters: {
    apiRoutes: {
      "GET /api/me": fixtureMe,
      "GET /api/groups": { groups },
      "GET /api/threads?limit=100": { threads: groupThreads },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Zulu planning");
    await userEvent.selectOptions(canvas.getByLabelText("Filter threads by group"), "design");
    expect(rowNames(canvasElement)).toEqual(["Bravo review", "Charlie follow-up"]);
    expect(localStorage.getItem("agora_threads_group")).toBe("design");
    await userEvent.selectOptions(canvas.getByLabelText("Filter threads"), "saved");
    expect(rowNames(canvasElement)).toEqual(["Bravo review"]);
    await userEvent.selectOptions(canvas.getByLabelText("Filter threads by group"), "");
    expect(rowNames(canvasElement)).toEqual(["Zulu planning", "Bravo review"]);
    expect(localStorage.getItem("agora_threads_group")).toBeNull();
    await userEvent.selectOptions(canvas.getByLabelText("Filter threads by group"), "design");
    expect(rowNames(canvasElement)).toEqual(["Bravo review"]);
  },
};

export const SelectedGroupOutsideFetchedThreads: Story = {
  parameters: {
    apiRoutes: {
      "GET /api/me": fixtureMe,
      "GET /api/groups": { groups },
      "GET /api/threads?limit=100": { threads: inboxThreads.slice(0, 2) },
    },
    setup: () => useUiState.setState({ threadsGroup: "design" }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("No matching threads")).resolves.toBeVisible();
    expect(canvas.getByLabelText("Filter threads by group")).toHaveValue("design");
    expect(useUiState.getState().threadsGroup).toBe("design");
  },
};

export const RemovedGroupClearsSelection: Story = {
  parameters: {
    apiRoutes: {
      "GET /api/me": fixtureMe,
      "GET /api/groups": { groups: fixtureGroups },
      "GET /api/threads?limit=100": { threads: inboxThreads.slice(0, 2) },
    },
    setup: () => useUiState.getState().setThreadsGroup("design"),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Zulu planning");
    await waitFor(() => expect(canvas.getByLabelText("Filter threads by group")).toHaveValue(""));
    expect(localStorage.getItem("agora_threads_group")).toBeNull();
  },
};

export const RemovedGroupWithThread: Story = {
  parameters: {
    apiRoutes: {
      "GET /api/me": fixtureMe,
      "GET /api/groups": { groups: fixtureGroups },
      "GET /api/threads?limit=100": { threads: [{ ...dmThread, group_id: "old", group_name: "" }] },
    },
    setup: () => useUiState.getState().setThreadsGroup("old"),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Private agent thread");
    expect(canvas.getByLabelText("Filter threads by group")).toHaveValue("old");
    expect(canvas.getByRole("option", { name: "Unknown group" })).toBeInTheDocument();
    expect(localStorage.getItem("agora_threads_group")).toBe("old");
  },
};

export const ReplyTimeStackOnNarrowScreen: Story = {
  globals: { viewport: { value: "smallPhone", isRotated: false } },
  parameters: {
    viewport: { defaultViewport: "smallPhone" },
    apiRoutes: {
      "GET /api/me": fixtureMe,
      "GET /api/groups": { groups: fixtureGroups },
      "GET /api/threads?limit=100": { threads: inboxThreads },
    },
  },
  play: async ({ canvasElement }) => {
    const row = await waitFor(() => {
      const candidate = canvasElement.querySelector(".ago-inbox-row");
      expect(candidate).not.toBeNull();
      return candidate!;
    });
    const stack = row.querySelector(".ago-inbox-time-stack");
    const relative = stack?.querySelector(".ts");
    const lastReply = stack?.querySelector(".ago-inbox-last-reply");
    await expect(relative).toHaveTextContent(/^\d+m$/);
    await expect(lastReply).toHaveTextContent(/^Last reply at /);
    expect(lastReply!.getBoundingClientRect().top).toBeGreaterThan(relative!.getBoundingClientRect().top);
    expect(lastReply!.scrollWidth).toBeLessThanOrEqual(lastReply!.clientWidth);
    expect(stack!.getBoundingClientRect().width).toBeLessThanOrEqual(150);
    const rows = [...canvasElement.querySelectorAll<HTMLElement>(".ago-inbox-row")];
    expect(rows).toHaveLength(4);
    const heights = rows.map(item => item.getBoundingClientRect().height);
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(2);
  },
};

export const MissingReplyTimestamp: Story = {
  parameters: {
    apiRoutes: {
      "GET /api/me": fixtureMe,
      "GET /api/groups": { groups: fixtureGroups },
      "GET /api/threads?limit=100": {
        threads: [{ ...fixtureThreads[0], last_reply_ts: 0 }],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const row = await waitFor(() => {
      const candidate = canvasElement.querySelector(".ago-inbox-row");
      expect(candidate).not.toBeNull();
      return candidate!;
    });
    await expect(row.querySelector(".ago-inbox-time-stack .ts")).toBeVisible();
    expect(row.querySelector(".ago-inbox-last-reply")).toBeNull();
  },
};

export const NoRepliesHidesReplyTimestamp: Story = {
  parameters: {
    apiRoutes: {
      "GET /api/me": fixtureMe,
      "GET /api/groups": { groups: fixtureGroups },
      "GET /api/threads?limit=100": {
        threads: [{ ...fixtureThreads[0], reply_count: 0, last_reply_ts: now - 300 }],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const row = await waitFor(() => {
      const candidate = canvasElement.querySelector(".ago-inbox-row");
      expect(candidate).not.toBeNull();
      return candidate!;
    });
    expect(row.querySelector(".ago-inbox-last-reply")).toBeNull();
  },
};

export const TabletReplyTimeFits: Story = {
  globals: { viewport: { value: "tabletComposer", isRotated: false } },
  parameters: {
    viewport: { defaultViewport: "tabletComposer" },
    apiRoutes: {
      "GET /api/me": fixtureMe,
      "GET /api/groups": { groups: fixtureGroups },
      "GET /api/threads?limit=100": {
        threads: [{
          ...fixtureThreads[0],
          root: { ...root, id: 47, alias: "Tablet reply time" },
          last_reply_ts: Math.floor(tabletReplyDate.getTime() / 1000),
        }],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const row = await waitFor(() => {
      const candidate = canvasElement.querySelector(".ago-inbox-row");
      expect(candidate).not.toBeNull();
      return candidate!;
    });
    const lastReply = row.querySelector<HTMLElement>(".ago-inbox-last-reply");
    const compact = row.querySelector<HTMLElement>(".ago-inbox-last-reply-compact");
    expect(compact).not.toBeNull();
    await expect(compact).toBeVisible();
    expect(lastReply!.scrollWidth).toBeLessThanOrEqual(lastReply!.clientWidth);
  },
};

export const SearchConversations: Story = {
  parameters: {
    apiRoutes: {
      "GET /api/me": fixtureMe,
      "GET /api/groups": { groups: fixtureGroups },
      "GET /api/threads?limit=100": { threads: inboxThreads },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const search = canvas.getByRole("searchbox", { name: "Search threads" });
    await userEvent.type(search, "Alpha");
    await expect(canvas.findByText("Alpha launch notes")).resolves.toBeVisible();
    await expect(canvas.queryByText("Zulu planning")).not.toBeInTheDocument();
    await userEvent.clear(search);
    await expect(canvas.findByText("Zulu planning")).resolves.toBeVisible();
  },
};
