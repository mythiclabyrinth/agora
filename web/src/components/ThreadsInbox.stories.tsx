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
const inboxThreads = [
  { ...fixtureThreads[0], root: { ...root, id: 42, alias: "Zulu planning" }, last_reply_ts: 400 },
  { ...fixtureThreads[0], root: { ...root, id: 43, alias: null, text: "Alpha launch notes" }, last_reply_ts: 300 },
  { ...fixtureThreads[0], root: { ...root, id: 44, alias: "Bravo review" }, last_reply_ts: 200 },
  { ...fixtureThreads[0], root: { ...root, id: 45, alias: null, text: "Charlie follow-up" }, last_reply_ts: 100 },
];

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

    useUiState.getState().selectChannel("__dms", "claude-m5-5b85", "replace");
    useUiState.getState().openThread(10897, "replace");
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
