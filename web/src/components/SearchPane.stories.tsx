import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import {
  fixtureAgentMessage,
  fixtureGroups,
  fixtureMe,
} from "@agora/core/testing/fixtures";
import { useUiState } from "../state/ui";
import { SearchPane } from "./SearchPane";

const hit = {
  ...fixtureAgentMessage,
  channel_name: "storybook",
  group_id: "product",
  group_name: "Product",
  // Keep a file card in the search fixture so its shared structure stays covered.
  attachments: [
    { id: "spec", filename: "search-result-spec.pdf", mime: "application/pdf", size: 262_144 },
  ],
  snippet: "The real panes use \u0001fixture\u0002 data.",
};

const routes = {
  "GET /api/me": { ...fixtureMe, search_ai: true },
  "GET /api/groups": { groups: fixtureGroups },
  "GET /api/search?q=fixture&types=messages,channels,groups,threads&totals=1&limit=5": {
    query: "fixture",
    groups: [{ id: "product", name: "Product", description: "Product planning", hidden: false }],
    channels: [{
      id: "general",
      group_id: "product",
      name: "storybook",
      topic: "Component development",
      hidden: false,
      group_name: "Product",
    }],
    messages: { items: [hit], has_more: false, offset: 0 },
  },
};

const dmHit = {
  ...hit,
  id: 10900,
  thread_id: 10897,
  channel_id: "claude-m5-5b85",
  channel_name: "Claude M5",
  group_id: "__dms",
  group_name: "Direct messages",
  text: "Private fixture result",
  snippet: "Private \u0001fixture\u0002 result",
  attachments: [],
};

const dmGroup = {
  id: "__dms",
  name: "Direct messages",
  description: "Private conversations with agents",
  created_by: null,
  created_at: 0,
  role: "member" as const,
  is_public: false,
  kind: "agent_dms",
  channels: [{
    id: "claude-m5-5b85",
    group_id: "",
    name: "Claude M5",
    topic: "",
    created_at: 0,
    unread: 0,
    mentions: 0,
  }],
};

const meta = {
  title: "Web/Connected/Search",
  component: SearchPane,
  parameters: {
    apiRoutes: routes,
    setup: () => useUiState.setState({ searchOpen: true }),
  },
} satisfies Meta<typeof SearchPane>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ResultsAndKeyboardNavigation: Story = {
  parameters: {
    docs: { description: { story: "Searches fixture-backed groups, channels, and messages. Escape-close is tested mid-run, then results are reopened for inspection." } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = await canvas.findByPlaceholderText("Search messages, channels, groups…");
    await userEvent.type(input, "fixture");
    await expect(canvas.findByText("Product planning")).resolves.toBeVisible();
    await expect(canvas.findByText("fixture")).resolves.toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(useUiState.getState().searchOpen).toBe(false);
    useUiState.getState().setSearchOpen(true);
    const reopened = await canvas.findByPlaceholderText("Search messages, channels, groups…");
    // The pane keeps its query across close/reopen — clear it or the retype
    // appends and queries a route the fixtures don't define.
    await userEvent.clear(reopened);
    await userEvent.type(reopened, "fixture");
    await expect(canvas.findByText("Product planning")).resolves.toBeVisible();
    const filename = await canvas.findByText("search-result-spec.pdf");
    expect(filename).toBeVisible();
    await expect(canvas.findByText("256.0 KB")).resolves.toBeVisible();
    expect(filename.closest(".ago-file-meta")).not.toBeNull();
    const card = filename.closest(".ago-att-file");
    expect(card).not.toBeNull();
    expect(card?.querySelector(".ago-file-icon")).not.toBeNull();
  },
};

export const InboxTabCommands: Story = {
  parameters: { apiRoutes: { ...routes, "GET /api/me": { ...fixtureMe, drafts_sync: true } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("Go to Approvals")).resolves.toBeVisible();
    await expect(canvas.findByText("Go to Drafts")).resolves.toBeVisible();
    await expect(canvas.findByText("Go to Schedules")).resolves.toBeVisible();
  },
};

export const AgentDirectMessageResult: Story = {
  parameters: {
    apiRoutes: {
      "GET /api/me": fixtureMe,
      "GET /api/groups": { groups: [...fixtureGroups, dmGroup] },
      "GET /api/search?q=fixture&group_id=__dms&types=messages,channels,groups,threads&totals=1&limit=5": {
        query: "fixture",
        groups: [],
        channels: [],
        threads: { items: [{
          id: 10897, channel_id: "claude-m5-5b85", channel_name: "Claude M5", group_id: "__dms", group_name: "Direct messages",
          alias: "Private fixture plan", reply_count: 1, last_activity: 1_793_000_000,
        }], has_more: false, offset: 0, total: 1 },
        messages: { items: [dmHit], has_more: false, offset: 0 },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByTitle("Search scope"));
    await userEvent.click(await canvas.findByRole("option", { name: "All of Direct messages" }));
    await userEvent.type(canvas.getByPlaceholderText("Search messages, channels, groups…"), "fixture");
    // A DM thread is named after the agent, not "#Claude M5" in a group.
    await expect(canvas.findByText("Claude M5 · Direct messages · 1 reply")).resolves.toBeVisible();
    const crumb = await canvas.findByText("Direct messages / #Claude M5 · in thread");
    await userEvent.click(crumb.closest(".ago-search-row.msg") as HTMLElement);
    expect(useUiState.getState().sel).toEqual({ g: "__dms", c: "claude-m5-5b85" });
    expect(useUiState.getState().threadRoot).toBe(10897);
    expect(window.location.pathname).toMatch(/\/g\/__dms\/c\/claude-m5-5b85\/t\/10897$/);
  },
};

/* Many channels per group: the scope list must stay a fixed-height,
   scrollable, filterable listbox rather than a screen-tall native menu. */
const manyGroups = ["Health", "Finance", "Random", "Trip", "Work"].map((name, gi) => ({
  ...fixtureGroups[0],
  id: `g${gi}`,
  name,
  channels: Array.from({ length: 6 }, (_, ci) => ({
    ...fixtureGroups[0].channels![0],
    id: `g${gi}-c${ci}`,
    group_id: `g${gi}`,
    name: ["personal", "fitness", "mealplan", "travel", "expenses", "issues"][ci] + (gi ? `-${gi}` : ""),
  })),
}));

export const ScopePicker: Story = {
  parameters: {
    apiRoutes: { ...routes, "GET /api/groups": { groups: manyGroups } },
    docs: { description: { story: "Fixed-height scope list with sticky group headings, a filter box, and keyboard selection." } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = await canvas.findByTitle("Search scope");
    expect(trigger).toHaveTextContent("Everywhere");
    await userEvent.click(trigger);
    const list = await canvas.findByRole("listbox", { name: "Search scope" });
    // Thirty-odd rows, but the popover keeps its fixed height and scrolls.
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    expect(list.closest(".ago-pick")!.getBoundingClientRect().height).toBeLessThanOrEqual(361);
    expect(within(list).getByRole("option", { name: "Everywhere" })).toHaveAttribute("aria-selected", "true");
    // Filtering keeps the matching channel under its group heading.
    await userEvent.type(canvas.getByPlaceholderText("Find a group or channel…"), "mealplan-3");
    await waitFor(() => expect(within(list).getAllByRole("option").map(o => o.textContent)).toEqual(["TripAll", "#mealplan-3"]));
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(trigger).toHaveTextContent("mealplan-3");
    expect(canvas.queryByRole("listbox")).toBeNull();
    // A choice hands focus back to the query, so Enter opens a result
    // rather than reopening the list.
    await waitFor(() => expect(document.activeElement).toBe(canvasElement.ownerDocument.getElementById("ago-search-input")));
    // Escape closes the list without closing search.
    await userEvent.click(trigger);
    await canvas.findByRole("listbox");
    await userEvent.keyboard("{Escape}");
    expect(canvas.queryByRole("listbox")).toBeNull();
    expect(useUiState.getState().searchOpen).toBe(true);
  },
};

const thread = (id: number, alias: string, last: number) => ({
  id, channel_id: "general", channel_name: "storybook", group_id: "product", group_name: "Product",
  alias, reply_count: id % 5, last_activity: last,
});
const channel = (i: number) => ({
  id: `ch${i}`, group_id: "product", name: `fixture-${i}`, topic: "", hidden: false, group_name: "Product",
});
const message = (i: number) => ({ ...hit, id: 20_000 + i, attachments: [], snippet: `Message ${i} about \u0001fixture\u0002` });
const overview = {
  query: "fixture",
  groups: [],
  groups_total: 0,
  channels: Array.from({ length: 20 }, (_, i) => channel(i)),
  channels_total: 31,
  threads: { items: Array.from({ length: 6 }, (_, i) => thread(500 + i, `Fixture thread ${i}`, 1_793_000_000 - i * 3600)), has_more: false, offset: 0, total: 6 },
  // One past the server's cap: "more than 1,000".
  messages: { items: Array.from({ length: 20 }, (_, i) => message(i)), has_more: true, offset: 0, total: 1001 },
};

export const CappedSectionsAndSeeAll: Story = {
  parameters: {
    apiRoutes: {
      ...routes,
      "GET /api/search?q=fixture&types=messages,channels,groups,threads&totals=1&limit=5": overview,
      "GET /api/search?q=fixture&types=threads&limit=50&totals=1": { query: "fixture", threads: overview.threads },
      "GET /api/search?q=fixture&types=channels&limit=50&totals=1": { query: "fixture", channels: overview.channels.slice(0, 20).concat(Array.from({ length: 30 }, (_, i) => channel(20 + i))).slice(0, 50), channels_total: 31 },
      "GET /api/search?q=fixture&sort=new&types=messages,channels,groups,threads&totals=1&limit=5": { ...overview, messages: { ...overview.messages, items: [message(99)] } },
    },
    docs: { description: { story: "Each kind shows four rows with its total; See all switches to that kind's full list, and the sort toggle reorders messages." } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByPlaceholderText("Search messages, channels, groups…"), "fixture");
    await canvas.findByText("Fixture thread 0");
    const body = canvasElement.ownerDocument.getElementById("ago-search-body")!;
    // Four rows per kind, whatever the server returned.
    expect(body.querySelectorAll(".ago-search-row.thread")).toHaveLength(4);
    expect(within(body).getAllByTitle(/^Open #fixture-/)).toHaveLength(4);
    expect(body.querySelectorAll(".ago-search-row.msg")).toHaveLength(4);
    const tabs = within(canvas.getByRole("tablist", { name: "Result kinds" }));
    expect(tabs.getByRole("tab", { name: "Messages 1,000+" })).toBeVisible();
    expect(tabs.getByRole("tab", { name: "Channels 31" })).toBeVisible();
    // See all → the Threads tab lists every thread.
    const threadsHead = (await canvas.findByText("Threads", { selector: ".ago-search-section span" })).parentElement!;
    await userEvent.click(within(threadsHead).getByRole("button", { name: /See all/ }));
    expect(tabs.getByRole("tab", { name: "Threads 6" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(body.querySelectorAll(".ago-search-row.thread")).toHaveLength(6));
    expect(body.querySelectorAll(".ago-search-row.msg")).toHaveLength(0);
    // The overview-only Ask row is gone, so the highlight starts on the first thread.
    expect(body.querySelector(".ago-search-row.ask")).toBeNull();
    expect(body.querySelector(".ago-search-row.sel")).toHaveTextContent("Fixture thread 0");
    // Back to All, then newest-first messages.
    await userEvent.click(tabs.getByRole("tab", { name: "All" }));
    await userEvent.click(canvas.getByRole("button", { name: "Newest" }));
    await canvas.findByText("Message 99 about");
    expect(canvas.getByRole("button", { name: "Newest" })).toHaveAttribute("aria-pressed", "true");
  },
};

export const PhoneWidthTabsAndSort: Story = {
  ...CappedSectionsAndSeeAll,
  globals: { viewport: { value: "smallPhone", isRotated: false } },
  parameters: {
    ...CappedSectionsAndSeeAll.parameters,
    docs: { description: { story: "At phone width the filters drop under the query and the sort toggle wraps under the tabs without overflowing." } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByPlaceholderText("Search messages, channels, groups…"), "fixture");
    await canvas.findByText("Fixture thread 0");
    const panel = canvasElement.ownerDocument.querySelector<HTMLElement>(".ago-search-panel")!;
    const sort = canvas.getByRole("group", { name: "Sort messages" });
    const right = panel.getBoundingClientRect().right;
    expect(sort.getBoundingClientRect().right).toBeLessThanOrEqual(right);
    expect(canvas.getByTitle("Search scope").getBoundingClientRect().right).toBeLessThanOrEqual(right);
    expect(canvas.getByTitle("Filter by attachment").getBoundingClientRect().right).toBeLessThanOrEqual(right);
  },
};

/* A "More results" page that lands after the list changed under it (here:
   the sort) belongs to the old list and must be dropped, not appended. */
let releaseStalePage = () => {};
const stalePage = () => new Promise(resolve => {
  releaseStalePage = () => resolve({ query: "fixture", messages: { items: [message(77)], has_more: false, offset: 20 } });
});

export const StaleMorePageIsDropped: Story = {
  parameters: {
    apiRoutes: {
      ...routes,
      "GET /api/search?q=fixture&types=messages,channels,groups,threads&totals=1&limit=5": overview,
      "GET /api/search?q=fixture&sort=new&types=messages,channels,groups,threads&totals=1&limit=5": overview,
      "GET /api/search?q=fixture&types=messages&limit=50": { query: "fixture", messages: overview.messages },
      "GET /api/search?q=fixture&sort=new&types=messages&limit=50": { query: "fixture", messages: { items: [message(99)], has_more: false, offset: 0 } },
      "GET /api/search?q=fixture&offset=20&types=messages&limit=50": stalePage,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByPlaceholderText("Search messages, channels, groups…"), "fixture");
    await userEvent.click(await canvas.findByRole("tab", { name: /^Messages/ }));
    await userEvent.click(await canvas.findByText("More results"));
    await userEvent.click(canvas.getByRole("button", { name: "Newest" }));
    await canvas.findByText("Message 99 about");
    releaseStalePage();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(canvas.queryByText("Message 77 about")).toBeNull();
    expect(canvasElement.ownerDocument.querySelectorAll(".ago-search-row.msg")).toHaveLength(1);
  },
};

export const ArrowKeysAfterClickingATab: Story = {
  parameters: CappedSectionsAndSeeAll.parameters,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByPlaceholderText("Search messages, channels, groups…"), "fixture");
    const threads = await canvas.findByRole("tab", { name: /^Threads/ });
    await userEvent.click(threads);
    await waitFor(() => expect(canvasElement.ownerDocument.querySelectorAll(".ago-search-row.thread")).toHaveLength(6));
    // Clicking the tab hands focus back to the query: arrows move the
    // highlight and Enter opens the highlighted thread.
    expect(canvas.getByPlaceholderText("Search messages, channels, groups…")).toHaveFocus();
    const body = canvasElement.ownerDocument.getElementById("ago-search-body")!;
    expect(body.querySelector(".ago-search-row.sel")).toHaveTextContent("Fixture thread 0");
    await userEvent.keyboard("{ArrowDown}");
    expect(body.querySelector(".ago-search-row.sel")).toHaveTextContent("Fixture thread 1");
    await userEvent.keyboard("{Enter}");
    expect(useUiState.getState().searchOpen).toBe(false);
    expect(useUiState.getState().threadRoot).toBe(501);
  },
};

const productGroup = { id: "product", name: "Product", description: "Product planning", hidden: false };
export const VanishedTabFallsBackToAll: Story = {
  parameters: {
    apiRoutes: {
      ...routes,
      "GET /api/search?q=fixture&types=messages,channels,groups,threads&totals=1&limit=5": { ...overview, groups: [productGroup], groups_total: 1 },
      "GET /api/search?q=fixture&types=groups&limit=50&totals=1": { query: "fixture", groups: [productGroup], groups_total: 1 },
      "GET /api/search?q=fixtures&types=messages,channels,groups,threads&totals=1&limit=5": { ...overview, query: "fixtures" },
      "GET /api/search?q=fixtures&types=groups&limit=50&totals=1": { query: "fixtures", groups: [], groups_total: 0 },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = await canvas.findByPlaceholderText("Search messages, channels, groups…");
    await userEvent.type(input, "fixture");
    await userEvent.click(await canvas.findByRole("tab", { name: "Groups 1" }));
    await canvas.findByText("Product planning");
    // The retyped query has no group hits: the Groups tab leaves, and so do we.
    await userEvent.type(input, "s");
    await waitFor(() => expect(canvas.queryByRole("tab", { name: /^Groups/ })).toBeNull());
    await waitFor(() => expect(canvas.getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "true"));
    await canvas.findByText("Fixture thread 0");
  },
};

// With an attachment filter, name kinds (even ones a stale response still
// carries) give way to messages: no sections, no See all.
export const FileFilterShowsMessagesOnly: Story = {
  parameters: {
    apiRoutes: {
      ...routes,
      "GET /api/search?q=fixture&types=messages,channels,groups,threads&totals=1&limit=5": overview,
      "GET /api/search?q=fixture&has_files=1&types=messages,channels,groups,threads&totals=1&limit=5": overview,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByPlaceholderText("Search messages, channels, groups…"), "fixture");
    await canvas.findByText("Fixture thread 0");
    await userEvent.click(canvas.getByTitle("Filter by attachment"));
    await userEvent.click(await canvas.findByRole("option", { name: "Has files" }));
    const body = canvasElement.ownerDocument.getElementById("ago-search-body")!;
    await waitFor(() => expect(body.querySelectorAll(".ago-search-row.thread")).toHaveLength(0));
    expect(within(body).queryAllByTitle(/^Open #/)).toHaveLength(0);
    expect([...body.querySelectorAll(".ago-search-section > span:first-child")].map(e => e.textContent)).toEqual(["Messages"]);
    expect(body.querySelectorAll(".ago-search-row.msg")).toHaveLength(4);
    const tabs = within(canvas.getByRole("tablist", { name: "Result kinds" }));
    expect(tabs.getAllByRole("tab").map(t => t.textContent)).toEqual(["All", "Messages1,000+"]);
  },
};

/* A tab opened before its own list arrives must not pass off the previous
   response as its first page: no borrowed rows, no More results to page
   from the wrong offset, no false "No messages". */
let releaseTabPage = () => {};
const slowTabPage = () => new Promise(resolve => {
  releaseTabPage = () => resolve({ query: "fixture", messages: { items: [message(41), message(42)], has_more: false, offset: 0 } });
});

export const TabWaitsForItsOwnList: Story = {
  parameters: {
    apiRoutes: {
      ...routes,
      "GET /api/search?q=fixture&types=messages,channels,groups,threads&totals=1&limit=5": overview,
      "GET /api/search?q=fixture&types=messages&limit=50": slowTabPage,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByPlaceholderText("Search messages, channels, groups…"), "fixture");
    await canvas.findByText("Fixture thread 0");
    await userEvent.click(canvas.getByRole("tab", { name: /^Messages/ }));
    const body = canvasElement.ownerDocument.getElementById("ago-search-body")!;
    await canvas.findByText("Searching…");
    expect(body.querySelectorAll(".ago-search-row")).toHaveLength(0);
    expect(canvas.queryByText("More results")).toBeNull();
    expect(canvas.queryByText(/^No /)).toBeNull();
    releaseTabPage();
    await canvas.findByText("Message 41 about");
    expect(body.querySelectorAll(".ago-search-row.msg")).toHaveLength(2);
    expect(canvas.queryByText("More results")).toBeNull();
  },
};

/* Totals: only messages stop at the cap ("1,000+"); other kinds are exact. */
export const ExactCountsBesideCappedMessages: Story = {
  parameters: {
    apiRoutes: {
      ...routes,
      "GET /api/search?q=fixture&types=messages,channels,groups,threads&totals=1&limit=5": { ...overview, channels_total: 1200 },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByPlaceholderText("Search messages, channels, groups…"), "fixture");
    const tabs = within(await canvas.findByRole("tablist", { name: "Result kinds" }));
    await expect(tabs.findByRole("tab", { name: "Channels 1,200" })).resolves.toBeVisible();
    expect(tabs.getByRole("tab", { name: "Messages 1,000+" })).toBeVisible();
  },
};

/* Exactly at the cap is an exact count, not "1,000+". */
export const ExactlyTheCapIsExact: Story = {
  parameters: {
    apiRoutes: {
      ...routes,
      "GET /api/search?q=fixture&types=messages,channels,groups,threads&totals=1&limit=5": { ...overview, messages: { ...overview.messages, total: 1000 } },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByPlaceholderText("Search messages, channels, groups…"), "fixture");
    const tabs = within(await canvas.findByRole("tablist", { name: "Result kinds" }));
    await expect(tabs.findByRole("tab", { name: "Messages 1,000" })).resolves.toBeVisible();
  },
};

/* Channels vanished while paging: the total still says 120, but a short
   page ends the list rather than offering More forever. */
const fiftyChannels = Array.from({ length: 50 }, (_, i) => channel(i));
export const ShortPageEndsTheList: Story = {
  parameters: {
    apiRoutes: {
      ...routes,
      "GET /api/search?q=fixture&types=messages,channels,groups,threads&totals=1&limit=5": { ...overview, channels_total: 120 },
      "GET /api/search?q=fixture&types=channels&limit=50&totals=1": { query: "fixture", channels: fiftyChannels, channels_total: 120 },
      "GET /api/search?q=fixture&offset=50&limit=50&types=channels": { query: "fixture", channels: Array.from({ length: 10 }, (_, i) => channel(50 + i)) },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByPlaceholderText("Search messages, channels, groups…"), "fixture");
    await userEvent.click(await canvas.findByRole("tab", { name: "Channels 120" }));
    await userEvent.click(await canvas.findByText("More results"));
    await canvas.findByTitle("Open #fixture-59");
    expect(canvas.queryByText("More results")).toBeNull();
  },
};

/* A second "More results" while the first is in flight is ignored: one
   request, one offset, no skipped rows. */
let morePageCalls = 0;
let releaseMorePage = () => {};
const slowMorePage = () => {
  morePageCalls += 1;
  return new Promise(resolve => {
    releaseMorePage = () => resolve({ query: "fixture", messages: { items: [message(60), message(61)], has_more: false, offset: 20 } });
  });
};
export const OneMorePageAtATime: Story = {
  parameters: {
    apiRoutes: {
      ...routes,
      "GET /api/search?q=fixture&types=messages,channels,groups,threads&totals=1&limit=5": overview,
      "GET /api/search?q=fixture&types=messages&limit=50": { query: "fixture", messages: overview.messages },
      "GET /api/search?q=fixture&offset=20&types=messages&limit=50": slowMorePage,
    },
  },
  play: async ({ canvasElement }) => {
    morePageCalls = 0;
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByPlaceholderText("Search messages, channels, groups…"), "fixture");
    await userEvent.click(await canvas.findByRole("tab", { name: /^Messages/ }));
    const more = await canvas.findByText("More results");
    await userEvent.click(more);
    await userEvent.click(canvasElement.ownerDocument.querySelector<HTMLElement>(".ago-search-row.more")!);
    expect(morePageCalls).toBe(1);
    releaseMorePage();
    await canvas.findByText("Message 61 about");
    expect(canvasElement.ownerDocument.querySelectorAll(".ago-search-row.msg")).toHaveLength(22);
    expect(morePageCalls).toBe(1);
  },
};

/* Newest on All, then a hop to another tab and back: the overview's query
   doesn't change, so it isn't fetched again (nor in the other order). */
let plainOverviewCalls = 0;
let newestOverviewCalls = 0;
export const TabHopsDontRefetchTheOverview: Story = {
  parameters: {
    apiRoutes: {
      ...routes,
      "GET /api/search?q=fixture&types=messages,channels,groups,threads&totals=1&limit=5": () => { plainOverviewCalls += 1; return overview; },
      "GET /api/search?q=fixture&sort=new&types=messages,channels,groups,threads&totals=1&limit=5": () => { newestOverviewCalls += 1; return overview; },
      "GET /api/search?q=fixture&types=threads&limit=50&totals=1": { query: "fixture", threads: overview.threads },
      "GET /api/search?q=fixture&sort=new&types=messages&limit=50": { query: "fixture", messages: { items: [message(99)], has_more: false, offset: 0 } },
      "GET /api/search?q=fixture&types=messages&limit=50": { query: "fixture", messages: overview.messages },
    },
  },
  play: async ({ canvasElement }) => {
    plainOverviewCalls = 0; newestOverviewCalls = 0;
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByPlaceholderText("Search messages, channels, groups…"), "fixture");
    await canvas.findByText("Fixture thread 0");
    await userEvent.click(canvas.getByRole("button", { name: "Newest" }));
    await waitFor(() => expect(newestOverviewCalls).toBe(1));
    await userEvent.click(canvas.getByRole("tab", { name: /^Threads/ }));
    await canvas.findByText("Fixture thread 5");
    await userEvent.click(canvas.getByRole("tab", { name: "All" }));
    await canvas.findByText("Fixture thread 0");
    expect(plainOverviewCalls).toBe(1);
    expect(newestOverviewCalls).toBe(1);
    // Newest set on All carries to Messages; toggling there leaves the overview alone.
    await userEvent.click(canvas.getByRole("tab", { name: /^Messages/ }));
    await canvas.findByText("Message 99 about");
    await userEvent.click(canvas.getByRole("button", { name: "Relevance" }));
    await canvas.findByText("Message 0 about");
    expect(plainOverviewCalls).toBe(1);
    expect(newestOverviewCalls).toBe(1);
  },
};

/* Reopening search starts over on Relevance, like the tab and pages. */
export const ReopenResetsSort: Story = {
  parameters: {
    apiRoutes: {
      ...routes,
      "GET /api/search?q=fixture&types=messages,channels,groups,threads&totals=1&limit=5": overview,
      "GET /api/search?q=fixture&sort=new&types=messages,channels,groups,threads&totals=1&limit=5": overview,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByPlaceholderText("Search messages, channels, groups…"), "fixture");
    await canvas.findByText("Fixture thread 0");
    await userEvent.click(canvas.getByRole("button", { name: "Newest" }));
    expect(canvas.getByRole("button", { name: "Newest" })).toHaveAttribute("aria-pressed", "true");
    useUiState.getState().setSearchOpen(false);
    await waitFor(() => expect(canvas.queryByRole("dialog")).toBeNull());
    useUiState.getState().setSearchOpen(true);
    await expect(canvas.findByRole("button", { name: "Relevance" })).resolves.toHaveAttribute("aria-pressed", "true");
    expect(canvas.getByRole("button", { name: "Newest" })).toHaveAttribute("aria-pressed", "false");
  },
};
