import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Alert, Text, TextInput } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiClient, ApiProvider, useAllSchedules, useApprovals, useMarkUnreadsRead, useMe, useSyncedDrafts, useUnreads, type Schedule } from "@agora/core";
import { fixtureSchedules } from "@agora/core/testing/fixtures";
import { SchedulesList, editedSpec, nextRunChange, parseLocalInput, formatLocalInput } from "../src/components/SchedulesList";
import { groupSchedulesByChannel, openSchedule } from "../src/components/SchedulesInbox";
import { channelToolActions, threadToolActions } from "../src/lib/conversationTools";
import InboxScreen from "../app/(app)/inbox";
import { useInboxTab } from "../src/state/inboxTab";

jest.mock("lucide-react-native", () => new Proxy({}, { get: () => function MockIcon() { return null; } }));
jest.mock("expo-router", () => ({ Stack: { Screen: () => null }, router: { push: jest.fn() }, useLocalSearchParams: jest.fn() }));
jest.mock("../app/(app)/threads", () => ({ ThreadsScreen: () => null }));
jest.mock("../src/components/SwipeRow", () => ({
  SwipeRow: ({ children }: React.PropsWithChildren) => children,
  useSwipeRows: () => ({ close: jest.fn() }),
}));
jest.mock("@agora/core", () => {
  const actual = jest.requireActual("@agora/core");
  return { ...actual, useUnreads: jest.fn(), useApprovals: jest.fn(), useMarkUnreadsRead: jest.fn(), useMe: jest.fn(),
    useSyncedDrafts: jest.fn(), useAllSchedules: jest.fn(actual.useAllSchedules) };
});

class TestApi extends ApiClient {
  readonly gets: string[] = [];
  readonly patches: { path: string; body: unknown }[] = [];
  readonly deletes: string[] = [];
  patchError: Error | null = null;
  truncated = false;
  /** What `?status=done` returns: the Done tab's own list. */
  done: Schedule[] = [];
  /** Holds `?status=done` responses until released (a slow refetch). */
  doneHold: Promise<void> | null = null;
  /** The server capped the done list. */
  doneTruncated = false;
  constructor(private readonly items: Schedule[]) { super({ baseUrl: "https://example.invalid", token: "test" }); }
  override async get<T>(path: string) {
    this.gets.push(path);
    if (path.includes("status=done")) {
      if (this.doneHold) await this.doneHold;
      return (this.doneTruncated ? { items: this.done, truncated: true } : { items: this.done }) as T;
    }
    return (this.truncated ? { items: this.items, truncated: true } : { items: this.items }) as T;
  }
  override async patch<T>(path: string, body?: unknown) {
    this.patches.push({ path, body });
    if (this.patchError) throw this.patchError;
    const id = decodeURIComponent(path.split("/").pop()!);
    return { schedule: { ...this.items.find(item => item.id === id)! } } as T;
  }
  override async delete<T>(path: string) { this.deletes.push(path); return { ok: true } as T; }
}

let tree: TestRenderer.ReactTestRenderer | undefined;
const clients: QueryClient[] = [];
afterEach(() => {
  act(() => tree?.unmount()); tree = undefined; jest.restoreAllMocks();
  clients.splice(0).forEach(client => client.clear());
});

async function flush() { for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); }
function wrap(api: ApiClient, element: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } });
  clients.push(qc);
  return React.createElement(QueryClientProvider, { client: qc }, React.createElement(ApiProvider, { client: api }, element));
}
function byLabel(label: string) {
  return tree!.root.findAll(node => node.props.accessibilityLabel === label && typeof node.props.onPress === "function");
}
function texts() { return tree!.root.findAllByType(Text).map(node => [node.props.children].flat().join("")); }

test("lists a channel's schedules with cadence, thread label, owner and agent; read-only rows have no actions", async () => {
  const api = new TestApi(fixtureSchedules);
  await act(async () => { tree = TestRenderer.create(wrap(api, React.createElement(SchedulesList, { channelId: "general", threadId: null }))); });
  await flush();
  expect(api.gets).toEqual(["/api/channels/general/schedules"]);
  const all = texts().join("\n");
  expect(all).toContain("Weekdays at 07:00 UTC");
  expect(all).toContain("Every 6 hours");
  expect(all).toContain("Responsive layout loop");
  expect(all).toContain("via claude-cli");
  expect(all).toContain("alice can no longer post in #storybook");
  // Managed rows get pause/cancel/change-time; Alice's paused one (can_manage false) gets none.
  expect(byLabel("Pause schedule: Every 6 hours")).toHaveLength(1);
  expect(byLabel("Cancel schedule: Every 6 hours")).toHaveLength(1);
  expect(byLabel("Change time: Every 6 hours")).toHaveLength(1);
  expect(tree!.root.findAll(node => typeof node.props.accessibilityLabel === "string" && node.props.accessibilityLabel.startsWith("Resume schedule"))).toHaveLength(0);
  // The first render pays the cold module transform, which on a loaded CI
  // runner can exceed jest's 5 s default (same as templates.test.ts).
}, 20_000);

test("thread view asks for that thread only and hides the thread label", async () => {
  const api = new TestApi([fixtureSchedules[0]]);
  await act(async () => { tree = TestRenderer.create(wrap(api, React.createElement(SchedulesList, { channelId: "general", threadId: 42 }))); });
  await flush();
  expect(api.gets).toEqual(["/api/channels/general/schedules?thread_id=42"]);
  expect(texts().join("\n")).not.toContain("Responsive layout loop");
});

test("pause sends a status PATCH and cancel sends DELETE after confirming", async () => {
  const api = new TestApi([fixtureSchedules[1]]);
  await act(async () => { tree = TestRenderer.create(wrap(api, React.createElement(SchedulesList, { channelId: "general", threadId: null }))); });
  await flush();
  await act(async () => { byLabel("Pause schedule: Every 6 hours")[0].props.onPress(); });
  await flush();
  expect(api.patches).toEqual([{ path: "/api/schedules/sch-watchdog", body: { status: "paused" } }]);
  jest.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => {
    buttons?.find(button => button.style === "destructive")?.onPress?.();
  });
  await act(async () => { byLabel("Cancel schedule: Every 6 hours")[0].props.onPress(); });
  await flush();
  expect(api.deletes).toEqual(["/api/schedules/sch-watchdog"]);
});

test("change time saves a new interval and shows the server's validation error in place", async () => {
  const api = new TestApi([fixtureSchedules[1]]);
  await act(async () => { tree = TestRenderer.create(wrap(api, React.createElement(SchedulesList, { channelId: "general", threadId: null }))); });
  await flush();
  await act(async () => { byLabel("Change time: Every 6 hours")[0].props.onPress(); });
  const count = tree!.root.findAllByType(TextInput).find(node => node.props.accessibilityLabel === "Every how many")!;
  expect(count.props.value).toBe("6");
  act(() => count.props.onChangeText("12"));
  await act(async () => { byLabel("Save time")[0].props.onPress(); });
  await flush();
  expect(api.patches).toEqual([{ path: "/api/schedules/sch-watchdog", body: { schedule: { kind: "interval", seconds: 43_200 } } }]);

  api.patchError = new Error("invalid cron rule: minute 99 out of range");
  await act(async () => { byLabel("Change time: Every 6 hours")[0].props.onPress(); });
  act(() => byLabel("Cron rule")[0].props.onPress());
  act(() => tree!.root.findAllByType(TextInput).find(node => node.props.accessibilityLabel === "Cron rule")!.props.onChangeText("99 * * * *"));
  await act(async () => { byLabel("Save time")[0].props.onPress(); });
  await flush();
  expect(texts().join("\n")).toContain("invalid cron rule: minute 99 out of range");
});

test("saving the time sheet without edits sends nothing", async () => {
  const api = new TestApi([fixtureSchedules[1]]);
  await act(async () => { tree = TestRenderer.create(wrap(api, React.createElement(SchedulesList, { channelId: "general", threadId: null }))); });
  await flush();
  await act(async () => { byLabel("Change time: Every 6 hours")[0].props.onPress(); });
  await act(async () => { byLabel("Save time")[0].props.onPress(); });
  await flush();
  // Re-sending the stored rule would restart its clock; nothing changed.
  expect(api.patches).toEqual([]);
  expect(byLabel("Save time")).toHaveLength(0);
});

test("an admin managing someone else's schedule edits only its next time", async () => {
  const others: Schedule = { ...fixtureSchedules[1], owner: "alice", owner_name: "Alice", is_owner: false };
  const api = new TestApi([others]);
  await act(async () => { tree = TestRenderer.create(wrap(api, React.createElement(SchedulesList, { channelId: "general", threadId: null }))); });
  await flush();
  await act(async () => { byLabel("Change time: Every 6 hours")[0].props.onPress(); });
  // No cadence tabs: only the owner changes how often it posts in their name.
  expect(byLabel("Cron rule")).toHaveLength(0);
  expect(texts().join("\n")).toContain("Only Alice can change how often it repeats");
  const input = tree!.root.findAllByType(TextInput).find(node => node.props.accessibilityLabel === "Date and time")!;
  act(() => input.props.onChangeText("2030-01-02 03:04"));
  await act(async () => { byLabel("Save time")[0].props.onPress(); });
  await flush();
  expect(api.patches).toEqual([{ path: "/api/schedules/sch-watchdog", body: { run_at: parseLocalInput("2030-01-02 03:04") } }]);
});

test("a re-armed one-off's editor starts from its live next run, not the stale spec time", async () => {
  const rearmed: Schedule = { ...fixtureSchedules[2], status: "active", last_error: null, can_manage: true, is_owner: true,
    schedule: { kind: "once", at: 1_750_000_000 }, run_at: 1_750_200_000, next_runs: [1_750_200_000] };
  const api = new TestApi([rearmed]);
  await act(async () => { tree = TestRenderer.create(wrap(api, React.createElement(SchedulesList, { channelId: "general", threadId: null }))); });
  await flush();
  const change = tree!.root.findAll(node => typeof node.props.accessibilityLabel === "string"
    && node.props.accessibilityLabel.startsWith("Change time:") && typeof node.props.onPress === "function")[0];
  await act(async () => { change.props.onPress(); });
  const input = tree!.root.findAllByType(TextInput).find(node => node.props.accessibilityLabel === "Date and time")!;
  expect(input.props.value).toBe(formatLocalInput(1_750_200_000));
});

test("time editor parsing: local date-times, minimum gap, cron field count", () => {
  const at = parseLocalInput("2026-10-25 07:00")!;
  expect(formatLocalInput(at)).toBe("2026-10-25 07:00");
  expect(parseLocalInput("2026-02-30 07:00")).toBeNull();
  expect(parseLocalInput("tomorrow")).toBeNull();
  const fields = { once: "2026-10-25 07:00", count: "4", unit: "minutes" as const, cron: "0 7 * * 1-5" };
  expect(editedSpec("interval", fields)).toEqual({ error: "The shortest gap is 5 minutes." });
  expect(editedSpec("interval", { ...fields, count: "2", unit: "hours" })).toEqual({ spec: { kind: "interval", seconds: 7200 } });
  // A gap that isn't whole minutes round-trips exactly.
  expect(editedSpec("interval", { ...fields, count: "330", unit: "seconds" })).toEqual({ spec: { kind: "interval", seconds: 330 } });
  expect(editedSpec("cron", fields)).toEqual({ spec: { kind: "cron", expr: "0 7 * * 1-5" } });
  expect(editedSpec("cron", { ...fields, cron: "0 7 * *" })).toHaveProperty("error");
  expect(editedSpec("once", fields)).toEqual({ spec: { kind: "once", at } });
});

test("optional next run for repeating schedules: empty keeps the server's, else a future time", () => {
  const now = parseLocalInput("2026-10-24 12:00")!;
  expect(nextRunChange("interval", "", now)).toBeNull();
  expect(nextRunChange("once", "2026-10-25 07:00", now)).toBeNull();
  expect(nextRunChange("cron", "2026-10-25 03:00", now)).toEqual({ run_at: parseLocalInput("2026-10-25 03:00") });
  expect(nextRunChange("interval", "2026-10-23 03:00", now)).toEqual({ error: "The next run must be in the future." });
  expect(nextRunChange("interval", "soon", now)).toHaveProperty("error");
});

test("an error shows on a done row too, not only when paused", async () => {
  const done: Schedule = { ...fixtureSchedules[1], status: "done", last_error: "already fired at Oct 24, 2026 07:00 UTC" };
  const api = new TestApi([done]);
  await act(async () => { tree = TestRenderer.create(wrap(api, React.createElement(SchedulesList, { channelId: "general", threadId: null }))); });
  await flush();
  expect(texts().join("\n")).toContain("already fired at Oct 24, 2026 07:00 UTC");
});

test("thread ⋯ sheet: attachments, schedules (thread-filtered), then read aloud", () => {
  const toggleSpeak = jest.fn();
  const actions = threadToolActions({ channelId: "general", channelName: "general", groupId: "team", rootId: 42,
    threadName: "Launch", ttsOk: true, speakAloud: true, toggleSpeak });
  expect(actions.map(action => action.label)).toEqual(["Thread attachments", "Schedules", "Read replies aloud"]);
  expect(actions[2].selected).toBe(true);
  actions[1].onPress();
  expect(router.push).toHaveBeenLastCalledWith({ pathname: "/(app)/schedules/[channelId]",
    params: { channelId: "general", channelName: "general", groupId: "team", threadId: "42", threadName: "Launch" } });
  actions[0].onPress();
  expect(router.push).toHaveBeenLastCalledWith(expect.objectContaining({ pathname: "/(app)/attachments/[channelId]",
    params: expect.objectContaining({ threadId: "42" }) }));
  actions[2].onPress();
  expect(toggleSpeak).toHaveBeenCalledTimes(1);
  expect(threadToolActions({ channelId: "general", rootId: 42, ttsOk: false, speakAloud: false, toggleSpeak }).map(a => a.label))
    .toEqual(["Thread attachments", "Schedules"]);
});

test("channel ⋯ sheet offers Schedules right after attachments", () => {
  const actions = channelToolActions({ channelId: "general", channelName: "general", groupId: "team", ttsOk: false,
    speakAloud: false, toggleSpeak: jest.fn(), stars: false, showMembers: true, onPins: jest.fn(), onStars: jest.fn(), onMembers: jest.fn() });
  expect(actions.map(action => action.label)).toEqual(["Channel attachments", "Schedules", "Pinned messages", "Participants"]);
  actions[1].onPress();
  expect(router.push).toHaveBeenLastCalledWith({ pathname: "/(app)/schedules/[channelId]",
    params: { channelId: "general", channelName: "general", groupId: "team" } });
});

test("inbox Schedules tab lists every visible schedule grouped by channel", async () => {
  useInboxTab.setState({ tab: "unreads", filter: "all" });
  const list = { data: [], total: 0, isLoading: false, isError: false, refetch: jest.fn() };
  (useUnreads as jest.Mock).mockReturnValue(list);
  (useApprovals as jest.Mock).mockReturnValue(list);
  (useMarkUnreadsRead as jest.Mock).mockReturnValue({ mutate: jest.fn(), isPending: false });
  (useMe as jest.Mock).mockReturnValue({ data: { drafts_sync: false } });
  (useSyncedDrafts as jest.Mock).mockReturnValue([]);
  (useLocalSearchParams as jest.Mock).mockReturnValue({ tab: "schedules" });
  const other = { ...fixtureSchedules[1], id: "sch-other", channel_id: "alpha", channel_name: "alpha" };
  (useAllSchedules as jest.Mock).mockReturnValue({ data: { items: [...fixtureSchedules, other] }, isLoading: false, isError: false, isRefetching: false, refetch: jest.fn() });
  await act(async () => { tree = TestRenderer.create(wrap(new TestApi([]), React.createElement(InboxScreen))); });
  const tab = tree!.root.findAll(node => node.props.accessibilityRole === "tab" && node.props.accessibilityLabel === "Schedules")[0];
  expect(tab.props.accessibilityState.selected).toBe(true);
  const headers = tree!.root.findAll(node => node.props.accessibilityRole === "header" && node.type === Text).map(node => node.props.children);
  expect(headers).toEqual(["# alpha", "# storybook"]);
  await act(async () => byLabel("Paused, 1")[0].props.onPress());
  expect(byLabel("Paused, 1")[0].props.accessibilityState.selected).toBe(true);
  expect(texts().join("\n")).not.toContain("Every 6 hours");
  await act(async () => byLabel("Active, 3")[0].props.onPress());
  expect(texts().join("\n")).not.toContain("@cursor weekly dependency report");

  expect(groupSchedulesByChannel([...fixtureSchedules, other]).map(item => item.id))
    .toEqual(["sch-other", "sch-watchdog", "sch-loop", "sch-paused"]);
});

test("a paused schedule's times are labelled as what resuming would do", async () => {
  const paused: Schedule = { ...fixtureSchedules[1], status: "paused", next_runs: [1_800_000_000, 1_800_021_600] };
  const api = new TestApi([paused]);
  await act(async () => { tree = TestRenderer.create(wrap(api, React.createElement(SchedulesList, { channelId: "general", threadId: null }))); });
  await flush();
  const all = texts().join("\n");
  expect(all).toMatch(/If resumed: /);
  expect(all).not.toMatch(/Next: /);
});

test("an owner who lost the channel sees why and keeps only Pause and Cancel", async () => {
  const lost: Schedule = { ...fixtureSchedules[1], can_manage: true, is_owner: true, channel_access: false };
  const api = new TestApi([lost]);
  await act(async () => { tree = TestRenderer.create(wrap(api, React.createElement(SchedulesList, { channelId: "general", threadId: null }))); });
  await flush();
  expect(texts().join("\n")).toContain("You no longer have access to this channel");
  expect(byLabel("Pause schedule: Every 6 hours")).toHaveLength(1);
  expect(byLabel("Resume schedule: Every 6 hours")).toHaveLength(0);
  expect(byLabel("Change time: Every 6 hours")).toHaveLength(0);
  expect(byLabel("Cancel schedule: Every 6 hours")).toHaveLength(1);
});

test("opening a schedule whose channel the owner lost goes nowhere", () => {
  (router.push as jest.Mock).mockClear();
  openSchedule({ ...fixtureSchedules[1], channel_access: false });
  expect(router.push).not.toHaveBeenCalled();
  openSchedule({ ...fixtureSchedules[1], channel_access: true });
  expect(router.push).toHaveBeenCalledTimes(1);
});

test("overlapping actions on two rows keep each row's own busy state", async () => {
  const a: Schedule = { ...fixtureSchedules[1], id: "sch-a", schedule: { kind: "interval", seconds: 21_600 } };
  const b: Schedule = { ...fixtureSchedules[1], id: "sch-b", schedule: { kind: "interval", seconds: 43_200 } };
  let releasePatch: () => void = () => {};
  let releaseDelete: () => void = () => {};
  class SlowApi extends TestApi {
    override async patch<T>(path: string, body?: unknown) {
      await new Promise<void>(resolve => { releasePatch = resolve; });
      return super.patch<T>(path, body);
    }
    override async delete<T>(path: string) {
      await new Promise<void>(resolve => { releaseDelete = resolve; });
      return super.delete<T>(path);
    }
  }
  const api = new SlowApi([a, b]);
  await act(async () => { tree = TestRenderer.create(wrap(api, React.createElement(SchedulesList, { channelId: "general", threadId: null }))); });
  await flush();
  jest.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => {
    buttons?.find(button => button.style === "destructive")?.onPress?.();
  });
  await act(async () => { byLabel("Pause schedule: Every 6 hours")[0].props.onPress(); });
  await act(async () => { byLabel("Cancel schedule: Every 12 hours")[0].props.onPress(); });
  // Both rows are busy at once.
  expect(byLabel("Pause schedule: Every 6 hours")).toHaveLength(0);
  expect(byLabel("Cancel schedule: Every 12 hours")).toHaveLength(0);
  // Row A settles; row B's request is still running and stays busy.
  await act(async () => { releasePatch(); });
  await flush();
  expect(byLabel("Cancel schedule: Every 6 hours")).toHaveLength(1);
  expect(byLabel("Cancel schedule: Every 12 hours")).toHaveLength(0);
  await act(async () => { releaseDelete(); });
  await flush();
});

test("the change-time sheet is an opaque surface over a scrim, never see-through", async () => {
  const { Modal, StyleSheet } = jest.requireActual("react-native");
  const api = new TestApi([fixtureSchedules[1]]);
  await act(async () => { tree = TestRenderer.create(wrap(api, React.createElement(SchedulesList, { channelId: "general", threadId: null }))); });
  await flush();
  await act(async () => { byLabel("Change time: Every 6 hours")[0].props.onPress(); });
  const modal = tree!.root.findByType(Modal);
  const opaque = (c: unknown) => typeof c === "string" && !/transparent|rgba\([^)]*,\s*0(\.0+)?\)/.test(c) && !/^#[0-9a-f]{8}$/i.test(c) && c !== "";
  // The sheet holding the editor (it has the SheetHeader) must paint a solid colour.
  const styled = modal.findAll(node => node.props.style && node.props.accessibilityViewIsModal);
  expect(styled.length).toBeGreaterThan(0);
  const sheet = StyleSheet.flatten(styled[0].props.style);
  expect(opaque(sheet.backgroundColor)).toBe(true);
  // …and the backdrop behind it dims the screen.
  const backdrop = modal.findAll(node => node.props.style && StyleSheet.flatten(node.props.style)?.justifyContent === "flex-end")[0];
  expect(StyleSheet.flatten(backdrop.props.style).backgroundColor).toBeTruthy();
});

test("a capped list says so under the rows; an uncapped one doesn't", async () => {
  const capped = new TestApi(fixtureSchedules);
  capped.truncated = true;
  await act(async () => { tree = TestRenderer.create(wrap(capped, React.createElement(SchedulesList, { channelId: "general", threadId: null }))); });
  await flush();
  expect(texts().some(t => t.startsWith("Showing the first 1,000 schedules (active first)"))).toBe(true);
  act(() => tree!.unmount());
  const full = new TestApi(fixtureSchedules);
  await act(async () => { tree = TestRenderer.create(wrap(full, React.createElement(SchedulesList, { channelId: "general", threadId: null }))); });
  await flush();
  expect(texts().some(t => t.startsWith("Showing the first 1,000"))).toBe(false);
});

test("schedule status tabs expose counts and selection, filter rows, and return to All", async () => {
  const api = new TestApi(fixtureSchedules);
  await act(async () => { tree = TestRenderer.create(wrap(api, React.createElement(SchedulesList, { channelId: "general", threadId: null }))); });
  await flush();
  expect(byLabel("All, 3")[0].props.accessibilityState.selected).toBe(true);
  await act(async () => byLabel("Active, 2")[0].props.onPress());
  expect(byLabel("Active, 2")[0].props.accessibilityState.selected).toBe(true);
  expect(texts().join("\n")).not.toContain("@cursor weekly dependency report");
  await act(async () => byLabel("Paused, 1")[0].props.onPress());
  expect(texts().join("\n")).toContain("@cursor weekly dependency report");
  expect(texts().join("\n")).not.toContain("Every 6 hours");
  await act(async () => byLabel("All, 3")[0].props.onPress());
  expect(texts().join("\n")).toContain("Every 6 hours");
});

test("the Done tab loads every finished schedule on its own, latest finished first", async () => {
  const api = new TestApi(fixtureSchedules);
  const finished = (id: string, text: string): Schedule => ({ ...fixtureSchedules[1], id, text, status: "done", thread_id: null, thread_title: null });
  api.done = [finished("d-new", "newest finished"), finished("d-old", "older finished")];
  await act(async () => { tree = TestRenderer.create(wrap(api, React.createElement(SchedulesList, { channelId: "general", threadId: null }))); });
  await flush();
  // Not fetched (and not counted) until the tab opens.
  expect(api.gets.some(path => path.includes("status=done"))).toBe(false);
  expect(byLabel("Done")).toHaveLength(1);
  await act(async () => byLabel("Done")[0].props.onPress());
  await flush();
  expect(api.gets).toContain("/api/channels/general/schedules?status=done");
  expect(byLabel("Done, 2")[0].props.accessibilityState.selected).toBe(true);
  const shown = texts().join("\n");
  expect(shown.indexOf("newest finished")).toBeGreaterThan(-1);
  expect(shown.indexOf("newest finished")).toBeLessThan(shown.indexOf("older finished"));
  // The other tabs still count the default list.
  expect(byLabel("All, 3")).toHaveLength(1);
  // Leaving Done drops its count: the cached list may be stale by the next visit.
  await act(async () => byLabel("All, 3")[0].props.onPress());
  expect(byLabel("Done")).toHaveLength(1);
  expect(byLabel("Done, 2")).toHaveLength(0);
  // Reopening refetches; the old count stays hidden until the new list lands.
  let release = () => {};
  api.doneHold = new Promise(resolve => { release = resolve; });
  api.done = [...api.done, finished("d-third", "third finished")];
  await act(async () => byLabel("Done")[0].props.onPress());
  await flush();
  expect(byLabel("Done")[0].props.accessibilityState.selected).toBe(true);
  expect(byLabel("Done, 2")).toHaveLength(0);
  await act(async () => { release(); });
  await flush();
  expect(byLabel("Done, 3")).toHaveLength(1);
});

test("an older server's live list on the Done tab shows only finished rows", async () => {
  const api = new TestApi(fixtureSchedules);
  // A server that predates ?status=done returns its live list instead.
  api.done = [...fixtureSchedules, { ...fixtureSchedules[1], id: "d-real", text: "really finished", status: "done" }];
  await act(async () => { tree = TestRenderer.create(wrap(api, React.createElement(SchedulesList, { channelId: "general", threadId: null }))); });
  await flush();
  await act(async () => byLabel("Done")[0].props.onPress());
  await flush();
  expect(byLabel("Done, 1")).toHaveLength(1);
  const shown = texts().join("\n");
  expect(shown).toContain("really finished");
  expect(shown).not.toContain("@cursor weekly dependency report");
});

test("a background refetch while Done is open keeps its count", async () => {
  const api = new TestApi(fixtureSchedules);
  api.done = [{ ...fixtureSchedules[1], id: "d1", status: "done" }, { ...fixtureSchedules[1], id: "d2", status: "done" }];
  await act(async () => { tree = TestRenderer.create(wrap(api, React.createElement(SchedulesList, { channelId: "general", threadId: null }))); });
  await flush();
  await act(async () => byLabel("Done")[0].props.onPress());
  await flush();
  expect(byLabel("Done, 2")).toHaveLength(1);
  // schedules_changed (or pull to refresh) refetches while the tab stays open.
  let release = () => {};
  api.doneHold = new Promise(resolve => { release = resolve; });
  api.done = [...api.done, { ...fixtureSchedules[1], id: "d3", status: "done" }];
  await act(async () => { void clients.at(-1)!.invalidateQueries({ queryKey: ["schedules"] }); });
  await flush();
  expect(byLabel("Done, 2")).toHaveLength(1);
  await act(async () => { release(); });
  await flush();
  expect(byLabel("Done, 3")).toHaveLength(1);
});

test("a capped Done list's badge says there are more", async () => {
  const api = new TestApi(fixtureSchedules);
  api.done = [{ ...fixtureSchedules[1], id: "d1", status: "done" }];
  api.doneTruncated = true;
  await act(async () => { tree = TestRenderer.create(wrap(api, React.createElement(SchedulesList, { channelId: "general", threadId: null }))); });
  await flush();
  await act(async () => byLabel("Done")[0].props.onPress());
  await flush();
  expect(byLabel("Done, 1+")[0].props.accessibilityState.selected).toBe(true);
  expect(texts()).toContain("1+");
});

test("inbox Done is one flat latest-finished-first list labelled by channel", async () => {
  useInboxTab.setState({ tab: "unreads", filter: "all" });
  const list = { data: [], total: 0, isLoading: false, isError: false, refetch: jest.fn() };
  (useUnreads as jest.Mock).mockReturnValue(list);
  (useApprovals as jest.Mock).mockReturnValue(list);
  (useMarkUnreadsRead as jest.Mock).mockReturnValue({ mutate: jest.fn(), isPending: false });
  (useMe as jest.Mock).mockReturnValue({ data: { drafts_sync: false } });
  (useSyncedDrafts as jest.Mock).mockReturnValue([]);
  (useLocalSearchParams as jest.Mock).mockReturnValue({ tab: "schedules" });
  (useAllSchedules as jest.Mock).mockReturnValue({ data: { items: fixtureSchedules }, isLoading: false, isError: false, isRefetching: false, refetch: jest.fn() });
  const row = (id: string, channel: string, text: string): Schedule =>
    ({ ...fixtureSchedules[1], id, channel_id: channel, channel_name: channel, thread_id: null, thread_title: null, text, status: "done" });
  const api = new TestApi([]);
  // zeta's older row must not jump ahead of alpha's newer one.
  api.done = [row("1", "zeta", "zeta newest"), row("2", "alpha", "alpha middle"), row("3", "zeta", "zeta oldest"),
    { ...row("4", "Claude", "dm oldest"), channel_kind: "agent_dm", group_id: "" }];
  await act(async () => { tree = TestRenderer.create(wrap(api, React.createElement(InboxScreen))); });
  await flush();
  await act(async () => byLabel("Done")[0].props.onPress());
  await flush();
  const headers = tree!.root.findAll(node => node.props.accessibilityRole === "header" && node.type === Text);
  expect(headers).toHaveLength(0);
  const shown = texts().join("\n");
  expect(shown.indexOf("zeta newest")).toBeLessThan(shown.indexOf("alpha middle"));
  expect(shown.indexOf("alpha middle")).toBeLessThan(shown.indexOf("zeta oldest"));
  expect(texts().filter(t => /^#(zeta|alpha)/.test(t)).length).toBeGreaterThanOrEqual(3);
  // An agent DM (group_id "") is labelled with the DMs group.
  expect(texts().some(t => t.startsWith("Claude · Direct messages"))).toBe(true);
});

test("empty schedule tabs have distinct copy and no zero badge", async () => {
  await act(async () => { tree = TestRenderer.create(wrap(new TestApi([]), React.createElement(SchedulesList, { channelId: "general", threadId: null }))); });
  await flush();
  expect(byLabel("All")).toHaveLength(1);
  await act(async () => byLabel("Active")[0].props.onPress());
  expect(texts().join("\n")).toContain("No active schedules");
  await act(async () => byLabel("Paused")[0].props.onPress());
  expect(texts().join("\n")).toContain("No paused schedules");
  await act(async () => byLabel("Done")[0].props.onPress());
  await flush();
  expect(texts().join("\n")).toContain("No done schedules");
});

test("inbox keeps one heading per channel on every tab when channels mix active and paused", async () => {
  useInboxTab.setState({ tab: "unreads", filter: "all" });
  const list = { data: [], total: 0, isLoading: false, isError: false, refetch: jest.fn() };
  (useUnreads as jest.Mock).mockReturnValue(list);
  (useApprovals as jest.Mock).mockReturnValue(list);
  (useMarkUnreadsRead as jest.Mock).mockReturnValue({ mutate: jest.fn(), isPending: false });
  (useMe as jest.Mock).mockReturnValue({ data: { drafts_sync: false } });
  (useSyncedDrafts as jest.Mock).mockReturnValue([]);
  (useLocalSearchParams as jest.Mock).mockReturnValue({ tab: "schedules" });
  const base = fixtureSchedules[1];
  const row = (id: string, channel: string, status: Schedule["status"], runAt: number): Schedule =>
    ({ ...base, id, channel_id: channel, channel_name: channel, thread_id: null, thread_title: null, status, run_at: runAt, can_manage: false });
  // Interleaved due times: a global live-first sort would split the channels.
  const items = [
    row("a-act", "alpha", "active", 100), row("s-act", "storybook", "active", 200),
    row("a-pau", "alpha", "paused", 300), row("s-pau", "storybook", "paused", 400),
  ];
  (useAllSchedules as jest.Mock).mockReturnValue({ data: { items }, isLoading: false, isError: false, isRefetching: false, refetch: jest.fn() });
  await act(async () => { tree = TestRenderer.create(wrap(new TestApi([]), React.createElement(InboxScreen))); });
  const headers = () => tree!.root.findAll(node => node.props.accessibilityRole === "header" && node.type === Text).map(node => node.props.children);
  expect(headers()).toEqual(["# alpha", "# storybook"]);
  await act(async () => byLabel("Active, 2")[0].props.onPress());
  expect(headers()).toEqual(["# alpha", "# storybook"]);
  await act(async () => byLabel("Paused, 2")[0].props.onPress());
  expect(headers()).toEqual(["# alpha", "# storybook"]);
});

test("a finished card deletes for good from its trash icon after confirming; live cards have none", async () => {
  const api = new TestApi(fixtureSchedules);
  const finished: Schedule = { ...fixtureSchedules[1], id: "d-1", text: "finished one", status: "done", thread_id: null, thread_title: null };
  api.done = [finished, { ...finished, id: "d-2", can_manage: false }];
  await act(async () => { tree = TestRenderer.create(wrap(api, React.createElement(SchedulesList, { channelId: "general", threadId: null }))); });
  await flush();
  expect(tree!.root.findAll(n => typeof n.props.accessibilityLabel === "string"
    && n.props.accessibilityLabel.startsWith("Delete schedule") && typeof n.props.onPress === "function")).toHaveLength(0);
  await act(async () => byLabel("Done")[0].props.onPress());
  await flush();
  // Only the one this person may manage gets the icon.
  const trash = byLabel("Delete schedule: Every 6 hours");
  expect(trash).toHaveLength(1);
  const alert = jest.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => {
    buttons?.find(button => button.style === "destructive")?.onPress?.();
  });
  await act(async () => { trash[0].props.onPress(); });
  await flush();
  expect(alert.mock.calls[0][0]).toBe("Delete schedule?");
  expect(api.deletes).toEqual(["/api/schedules/d-1?purge=1"]);
});
