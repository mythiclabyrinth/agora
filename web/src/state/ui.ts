/* Which pane the main column shows, and which overlay panel is open.
   Selection persists to localStorage: agora_sel = {g,c}; agora_open = an
   array of expanded group ids, or null meaning "just the selected group";
   agora_thread = "expanded"/"open"; agora_unreads_only = "1"/"0";
   agora_chan_collapsed = channel ids whose sidebar threads are collapsed;
   agora_threads_sort and agora_threads_filter control the Threads inbox.
   The unread filter stays in memory, so a reload resets it to All. The Inbox
   tab lives in the URL: reloading an app-written /inbox/threads entry resets
   it to Unreads (lib/inboxReload.ts), while a pasted or bookmarked link keeps
   Threads. */

import { create } from "zustand";
import { deepLinkPath, type ThreadFilter, type ThreadSort, type UnreadFilter } from "@agora/core";
import { voiceCancel } from "./voiceRec";
import { liveStop, useLiveVoice } from "./liveVoice";
import { speakStop } from "./speak";

export type MainView =
  | { kind: "channel" }
  | { kind: "inbox" }
  | { kind: "group" };

export type Panel = "people" | "connections" | "settings" | null;
export type SettingsTab = "appearance" | "keyboard" | "notifications" | "workspace" | "features" | "credentials";
export type InboxTab = "unreads" | "threads" | "approvals";

export interface Selection { g?: string | null; c?: string | null; }

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function loadEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const value = localStorage.getItem(key);
  return allowed.includes(value as T) ? value as T : fallback;
}

export function normalizeGroupId(g: string): string {
  return g === "" ? "__dms" : g;
}

export function normalizeSelection(sel: Selection): Selection {
  return sel.g === "" && sel.c ? { ...sel, g: normalizeGroupId(sel.g) } : sel;
}

function loadSelection(): Selection {
  return normalizeSelection(loadJSON<Selection>("agora_sel", {}));
}

function loadSoundEnabled(): boolean {
  try { return localStorage.getItem("agora_sound_enabled") !== "0"; }
  catch { return true; }
}

function soundVolume(value: number): number {
  return Math.round(Math.min(100, Math.max(0, Number.isFinite(value) ? value : 70)));
}

function loadSoundVolume(): number {
  try {
    const raw = localStorage.getItem("agora_sound_volume");
    return raw === null || raw.trim() === "" ? 70 : soundVolume(Number(raw));
  } catch { return 70; }
}

const initialSelection = loadSelection();

interface UiState {
  sel: Selection;
  view: MainView;
  /** Slack-style phone drill-down: which column a narrow viewport shows. */
  mobileView: "side" | "main" | "thread";
  panel: Panel;
  settingsTab: SettingsTab;
  /** Expanded group ids; null = "the selected group counts as expanded". */
  expanded: string[] | null;
  collapsedChannels: string[];
  unreadsOnly: boolean;
  soundEnabled: boolean;
  soundVolume: number;
  threadsSort: ThreadSort;
  threadsFilter: ThreadFilter;
  threadsGroup: string | null;
  inboxTab: InboxTab;
  inboxFilter: UnreadFilter;
  hiddenOpen: boolean;
  sideCollapsed: boolean;
  threadRoot: number | null;
  threadExpanded: boolean;
  membersOpen: boolean;
  filesOpen: boolean;
  filesThread: number | null;
  searchOpen: boolean;
  selectChannel: (g: string, c: string, history?: "push" | "replace" | "none") => void;
  openInbox: (history?: "push" | "replace" | "none") => void;
  goInbox: (tab?: InboxTab, history?: "push" | "replace" | "none") => void;
  openGroupPage: (g: string, history?: "push" | "replace" | "none") => void;
  backToGroups: () => void;
  isExpanded: (g: string) => boolean;
  setExpanded: (g: string, on: boolean) => void;
  toggleGroup: (g: string) => void;
  isChannelCollapsed: (c: string) => boolean;
  toggleChannelThreads: (c: string) => void;
  setUnreadsOnly: (on: boolean) => void;
  setSoundEnabled: (on: boolean) => void;
  setSoundVolume: (volume: number) => void;
  setThreadsSort: (sort: ThreadSort) => void;
  setThreadsFilter: (filter: ThreadFilter) => void;
  setThreadsGroup: (groupId: string | null) => void;
  setInboxTab: (tab: InboxTab) => void;
  setInboxFilter: (filter: UnreadFilter) => void;
  toggleHiddenSection: () => void;
  toggleSide: () => void;
  openThread: (rootId: number, history?: "push" | "replace" | "none") => void;
  closeThread: (history?: "push" | "replace" | "none") => void;
  toggleThreadSize: () => void;
  setMembersOpen: (on: boolean) => void;
  setFilesOpen: (on: boolean, threadId?: number | null) => void;
  setSearchOpen: (on: boolean) => void;
  openPanel: (p: Panel) => void;
  setSettingsTab: (tab: SettingsTab) => void;
}

export const useUiState = create<UiState>((set, get) => ({
  sel: initialSelection,
  view: { kind: "channel" },
  // Phones land on the channel when one is remembered, else the group list.
  mobileView: initialSelection.c ? "main" : "side",
  panel: null,
  settingsTab: "appearance",
  expanded: loadJSON<string[] | null>("agora_open", null),
  collapsedChannels: loadJSON<string[]>("agora_chan_collapsed", []),
  unreadsOnly: localStorage.getItem("agora_unreads_only") === "1",
  soundEnabled: loadSoundEnabled(),
  soundVolume: loadSoundVolume(),
  threadsSort: loadEnum("agora_threads_sort", ["recent", "oldest", "az", "za"], "recent"),
  threadsFilter: loadEnum("agora_threads_filter", ["all", "saved", "unset"], "all"),
  threadsGroup: localStorage.getItem("agora_threads_group") || null,
  inboxTab: "unreads",
  inboxFilter: "all",
  hiddenOpen: false,
  sideCollapsed: localStorage.getItem("agora_side") === "collapsed",
  threadRoot: null,
  threadExpanded: localStorage.getItem("agora_thread") === "expanded",
  membersOpen: false,
  filesOpen: false,
  filesThread: null,
  searchOpen: false,

  selectChannel: (g, c, history = "push") => set((s) => {
    const normalizedGroupId = normalizeGroupId(g);
    if (s.sel.c !== c || s.sel.g !== normalizedGroupId) {
      // A recording is tied to the channel it started in; so are a live
      // session and the speak queue.
      voiceCancel();
      liveStop();
      speakStop();
    }
    localStorage.setItem("agora_sel", JSON.stringify({ g: normalizedGroupId, c }));
    writeHistory(deepLinkPath({ kind: "channel", groupId: normalizedGroupId, channelId: c }), history);
    return { sel: { g: normalizedGroupId, c }, view: { kind: "channel" }, threadRoot: null,
      filesOpen: false, filesThread: null, mobileView: "main" as const };
  }),
  openInbox: (history = "push") => get().goInbox(undefined, history),
  goInbox: (tab, history = "push") => {
    const inboxTab = tab ?? get().inboxTab;
    writeHistory(`/inbox/${inboxTab}`, history);
    set({ inboxTab, view: { kind: "inbox" }, threadRoot: null, mobileView: "main" });
  },
  openGroupPage: (g, history = "push") => set((s) => {
    const sel = { ...s.sel, g };
    localStorage.setItem("agora_sel", JSON.stringify(sel));
    writeHistory(deepLinkPath({ kind: "group", groupId: g }), history);
    return { sel, view: { kind: "group" }, threadRoot: null, mobileView: "main" as const };
  }),
  backToGroups: () => set({ mobileView: "side" }),

  isExpanded: (g) => {
    const s = get();
    return s.expanded ? s.expanded.includes(g) : g === s.sel.g;
  },
  setExpanded: (g, on) => set((s) => {
    const cur = s.expanded ? [...s.expanded] : (s.sel.g ? [s.sel.g] : []);
    const expanded = on ? [...new Set([...cur, g])] : cur.filter(x => x !== g);
    localStorage.setItem("agora_open", JSON.stringify(expanded));
    return { expanded };
  }),
  toggleGroup: (g) => get().setExpanded(g, !get().isExpanded(g)),
  isChannelCollapsed: (c) => get().collapsedChannels.includes(c),
  toggleChannelThreads: (c) => set((s) => {
    const collapsedChannels = s.collapsedChannels.includes(c)
      ? s.collapsedChannels.filter(id => id !== c)
      : [...s.collapsedChannels, c];
    localStorage.setItem("agora_chan_collapsed", JSON.stringify(collapsedChannels));
    return { collapsedChannels };
  }),

  setUnreadsOnly: (on) => {
    localStorage.setItem("agora_unreads_only", on ? "1" : "0");
    set({ unreadsOnly: on });
  },
  setSoundEnabled: (on) => {
    try { localStorage.setItem("agora_sound_enabled", on ? "1" : "0"); }
    catch { /* Private/managed browsers can deny storage. */ }
    set({ soundEnabled: on });
  },
  setSoundVolume: (volume) => {
    const next = soundVolume(volume);
    try { localStorage.setItem("agora_sound_volume", String(next)); }
    catch { /* Private/managed browsers can deny storage. */ }
    set({ soundVolume: next });
  },
  setThreadsSort: (sort) => {
    localStorage.setItem("agora_threads_sort", sort);
    set({ threadsSort: sort });
  },
  setThreadsFilter: (filter) => {
    localStorage.setItem("agora_threads_filter", filter);
    set({ threadsFilter: filter });
  },
  setThreadsGroup: (groupId) => {
    if (groupId === null) localStorage.removeItem("agora_threads_group");
    else localStorage.setItem("agora_threads_group", groupId);
    set({ threadsGroup: groupId });
  },
  setInboxTab: (tab) => { if (get().inboxTab !== tab) set({ inboxTab: tab }); },
  setInboxFilter: (filter) => { if (get().inboxFilter !== filter) set({ inboxFilter: filter }); },
  toggleHiddenSection: () => set((s) => ({ hiddenOpen: !s.hiddenOpen })),
  toggleSide: () => set((s) => {
    const next = !s.sideCollapsed;
    localStorage.setItem("agora_side", next ? "collapsed" : "open");
    return { sideCollapsed: next };
  }),
  openThread: (rootId, history = "push") => set((s) => {
    // Switching threads ends a recording/live session scoped to another one.
    const scope = useLiveVoice.getState().scope;
    if (scope && scope.threadId != null && scope.threadId !== rootId) liveStop();
    if (s.sel.g && s.sel.c) {
      writeHistory(deepLinkPath({
        kind: "thread", groupId: s.sel.g, channelId: s.sel.c, threadId: rootId,
      }), history);
    }
    return { threadRoot: rootId, filesOpen: false, filesThread: null, mobileView: "thread" as const };
  }),
  closeThread: (history = "replace") => set((s) => {
    const scope = useLiveVoice.getState().scope;
    if (scope && scope.threadId != null) liveStop();
    if (s.sel.g && s.sel.c) {
      writeHistory(deepLinkPath({
        kind: "channel", groupId: s.sel.g, channelId: s.sel.c,
      }), history);
    }
    return { threadRoot: null, filesOpen: false, filesThread: null, mobileView: "main" as const };
  }),
  toggleThreadSize: () => set((s) => {
    const next = !s.threadExpanded;
    localStorage.setItem("agora_thread", next ? "expanded" : "open");
    return { threadExpanded: next };
  }),
  setMembersOpen: (on) => set({ membersOpen: on, filesOpen: on ? false : get().filesOpen }),
  setFilesOpen: (on, threadId = null) => set({
    filesOpen: on, filesThread: threadId, membersOpen: on ? false : get().membersOpen,
  }),
  setSearchOpen: (on) => set({ searchOpen: on }),
  openPanel: (p) => set((s) => ({ panel: s.panel === p ? null : p })),
  setSettingsTab: settingsTab => set({ settingsTab }),
}));

const historyIndex = (): number | null => {
  const index = window.history.state?.agoraHistoryIndex;
  return Number.isSafeInteger(index) && index >= 0 ? index : null;
};
let maxAgoraHistoryIndex = historyIndex() ?? 0;

export function navigateAgoraHistory(direction: "back" | "forward"): boolean {
  const index = historyIndex() ?? 0;
  if (direction === "back" ? index <= 0 : index >= maxAgoraHistoryIndex) return false;
  window.history[direction]();
  return true;
}

export function writeHistory(path: string, mode: "push" | "replace" | "none"): void {
  if (mode === "none" || window.location.pathname === path) return;
  const index = historyIndex();
  if (mode === "push") {
    const next = (index ?? 0) + 1;
    maxAgoraHistoryIndex = next;
    window.history.pushState({ agoraHistoryIndex: next }, "", path);
  } else {
    const current = index ?? 0;
    maxAgoraHistoryIndex = Math.max(maxAgoraHistoryIndex, current);
    window.history.replaceState({ agoraHistoryIndex: current }, "", path);
  }
}
