/* Which pane the main column shows, and which overlay panel is open.
   Selection persists to localStorage: agora_sel = {g,c}; agora_open = an
   array of expanded group ids, or null meaning "just the selected group";
   agora_thread = "expanded"/"open"; agora_unreads_only = "1"/"0";
   agora_chan_collapsed = channel ids whose sidebar threads are collapsed. */

import { create } from "zustand";
import { deepLinkPath } from "@agora/core";
import { voiceCancel } from "./voiceRec";
import { liveStop, useLiveVoice } from "./liveVoice";
import { speakStop } from "./speak";

export type MainView =
  | { kind: "channel" }
  | { kind: "inbox" }
  | { kind: "group" };

export type Panel = "people" | "connections" | null;

interface Selection { g?: string | null; c?: string | null; }

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

interface UiState {
  sel: Selection;
  view: MainView;
  /** Slack-style phone drill-down: which column a narrow viewport shows. */
  mobileView: "side" | "main" | "thread";
  panel: Panel;
  /** Expanded group ids; null = "the selected group counts as expanded". */
  expanded: string[] | null;
  collapsedChannels: string[];
  unreadsOnly: boolean;
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
  openGroupPage: (g: string, history?: "push" | "replace" | "none") => void;
  backToGroups: () => void;
  isExpanded: (g: string) => boolean;
  setExpanded: (g: string, on: boolean) => void;
  toggleGroup: (g: string) => void;
  isChannelCollapsed: (c: string) => boolean;
  toggleChannelThreads: (c: string) => void;
  setUnreadsOnly: (on: boolean) => void;
  toggleHiddenSection: () => void;
  toggleSide: () => void;
  openThread: (rootId: number, history?: "push" | "replace" | "none") => void;
  closeThread: (history?: "push" | "replace" | "none") => void;
  toggleThreadSize: () => void;
  setMembersOpen: (on: boolean) => void;
  setFilesOpen: (on: boolean, threadId?: number | null) => void;
  setSearchOpen: (on: boolean) => void;
  openPanel: (p: Panel) => void;
}

export const useUiState = create<UiState>((set, get) => ({
  sel: loadJSON<Selection>("agora_sel", {}),
  view: { kind: "channel" },
  // Phones land on the channel when one is remembered, else the group list.
  mobileView: loadJSON<Selection>("agora_sel", {}).c ? "main" : "side",
  panel: null,
  expanded: loadJSON<string[] | null>("agora_open", null),
  collapsedChannels: loadJSON<string[]>("agora_chan_collapsed", []),
  unreadsOnly: localStorage.getItem("agora_unreads_only") === "1",
  hiddenOpen: false,
  sideCollapsed: localStorage.getItem("agora_side") === "collapsed",
  threadRoot: null,
  threadExpanded: localStorage.getItem("agora_thread") === "expanded",
  membersOpen: false,
  filesOpen: false,
  filesThread: null,
  searchOpen: false,

  selectChannel: (g, c, history = "push") => set((s) => {
    if (s.sel.c !== c || s.sel.g !== g) {
      // A recording is tied to the channel it started in; so are a live
      // session and the speak queue.
      voiceCancel();
      liveStop();
      speakStop();
    }
    localStorage.setItem("agora_sel", JSON.stringify({ g, c }));
    writeHistory(deepLinkPath({ kind: "channel", groupId: g, channelId: c }), history);
    return { sel: { g, c }, view: { kind: "channel" }, threadRoot: null,
      filesOpen: false, filesThread: null, mobileView: "main" as const };
  }),
  openInbox: (history = "push") => {
    writeHistory("/threads", history);
    set({ view: { kind: "inbox" }, threadRoot: null, mobileView: "main" });
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
}));

function writeHistory(path: string, mode: "push" | "replace" | "none"): void {
  if (mode === "none" || window.location.pathname === path) return;
  window.history[mode === "replace" ? "replaceState" : "pushState"]({}, "", path);
}
