const mockRead = jest.fn();
const mockWrite = jest.fn().mockResolvedValue(undefined);
jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///test/",
  readAsStringAsync: (...args: unknown[]) => mockRead(...args),
  writeAsStringAsync: (...args: unknown[]) => mockWrite(...args),
}));

import { usePrefs } from "../src/state/prefs";

beforeEach(() => {
  mockRead.mockReset();
  mockWrite.mockClear();
  usePrefs.setState({
    loaded: false,
    collapsedGroups: {},
    unreadsOnly: false,
    speakAloud: false,
    recentEmoji: [],
    preferNativeApps: true,
    linkBrowser: "in-app",
    requireAgentOffThreads: [],
  });
});

it("defaults new link preferences when an old prefs file has no keys", async () => {
  mockRead.mockResolvedValue(JSON.stringify({ collapsedGroups: [], unreadsOnly: true }));
  await usePrefs.getState().load();
  expect(usePrefs.getState()).toMatchObject({
    loaded: true,
    preferNativeApps: true,
    linkBrowser: "in-app",
  });
});

it("rejects non-boolean native-app preferences from a corrupt file", async () => {
  mockRead.mockResolvedValue(JSON.stringify({ preferNativeApps: "false" }));
  await usePrefs.getState().load();
  expect(usePrefs.getState().preferNativeApps).toBe(true);
});

it("does not wedge loading when the prefs file is corrupt", async () => {
  mockRead.mockResolvedValue("not json");
  await usePrefs.getState().load();
  expect(usePrefs.getState().loaded).toBe(true);
});

it("persists both link preference axes", () => {
  usePrefs.getState().setPreferNativeApps(false);
  usePrefs.getState().setLinkBrowser("system");
  const saved = JSON.parse(mockWrite.mock.calls.at(-1)![1]);
  expect(saved).toMatchObject({ preferNativeApps: false, linkBrowser: "system" });
});

it("expands only the requested collapsed group and persists the change", () => {
  usePrefs.setState({ collapsedGroups: { alpha: true, beta: true } });
  usePrefs.getState().expandGroup("alpha");
  expect(usePrefs.getState().collapsedGroups).toEqual({ beta: true });
  expect(mockWrite).toHaveBeenCalledWith(
    "file:///test/ui-prefs.json",
    expect.stringContaining('"collapsedGroups":["beta"]'),
  );
});

it("does not persist when the group is already expanded", () => {
  usePrefs.getState().expandGroup("alpha");
  expect(mockWrite).not.toHaveBeenCalled();
});

it("is on by default for a thread with no stored exception", () => {
  expect(usePrefs.getState().isRequireAgent("general:t99")).toBe(true);
});

it("persists require-agent exceptions with an LRU off-list", () => {
  usePrefs.getState().setRequireAgent("general:t1", false);
  usePrefs.getState().setRequireAgent("general:t2", false);
  expect(usePrefs.getState().isRequireAgent("general:t1")).toBe(false);
  const saved = JSON.parse(mockWrite.mock.calls.at(-1)![1]);
  expect(saved.requireAgentOffThreads).toEqual(["general:t2", "general:t1"]);
  usePrefs.getState().setRequireAgent("general:t1", true);
  expect(usePrefs.getState().isRequireAgent("general:t1")).toBe(true);
  expect(JSON.parse(mockWrite.mock.calls.at(-1)![1]).requireAgentOffThreads).toEqual([
    "general:t2",
  ]);
});

it("loads require-agent exceptions defensively and defaults missing keys", async () => {
  mockRead.mockResolvedValue(
    JSON.stringify({ requireAgentOffThreads: ["ok", 12, "", "also"] }),
  );
  await usePrefs.getState().load();
  expect(usePrefs.getState().requireAgentOffThreads).toEqual(["ok", "also"]);
});

it("ignores the legacy requireAgentThreads on-list instead of inverting it", async () => {
  mockRead.mockResolvedValue(
    JSON.stringify({ requireAgentThreads: ["general:t1"] }),
  );
  await usePrefs.getState().load();
  expect(usePrefs.getState().requireAgentOffThreads).toEqual([]);
  expect(usePrefs.getState().isRequireAgent("general:t1")).toBe(true);
});

it("defaults require-agent exceptions when an old prefs file has no key", async () => {
  mockRead.mockResolvedValue(JSON.stringify({ collapsedGroups: [], unreadsOnly: true }));
  await usePrefs.getState().load();
  expect(usePrefs.getState().requireAgentOffThreads).toEqual([]);
});
