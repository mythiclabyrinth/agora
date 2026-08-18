/* Small persisted UI prefs (group expansion, unreads-only filter) so the
   home screen looks the way you left it. Backed by a JSON file in the app's
   document dir — same pattern as the background poller's snapshot; nothing
   here is secret so the keychain would be overkill. */

import * as FileSystem from "expo-file-system/legacy";
import { create } from "zustand";
import {
  forgetRequireAgentOff,
  isRequireAgentOn,
  parseRequireAgentKeys,
  rememberRequireAgentOff,
} from "@agora/core";

const PREFS_FILE = `${FileSystem.documentDirectory ?? ""}ui-prefs.json`;

const RECENT_EMOJI_MAX = 24;

interface PersistedPrefs {
  collapsedGroups: string[];
  unreadsOnly: boolean;
  speakAloud: boolean;
  recentEmoji: string[];
  preferNativeApps: boolean;
  linkBrowser: LinkBrowser;
  /** Conversation keys (`threadAddressKey`) where require-agent was switched
      OFF. Absent = on, which is the default. Renamed from the old
      `requireAgentThreads` on-list so stale blobs are ignored, not inverted. */
  requireAgentOffThreads: string[];
}

export type LinkBrowser = "in-app" | "system" | "chrome";

interface PrefsState {
  loaded: boolean;
  /** Collapsed (not expanded) set, so unseen groups default to expanded. */
  collapsedGroups: Record<string, true>;
  unreadsOnly: boolean;
  /** 🔊: agent replies in the channel you're viewing are read aloud (TTS). */
  speakAloud: boolean;
  /** Most-recently-picked emoji, newest first (the picker's top row). */
  recentEmoji: string[];
  preferNativeApps: boolean;
  linkBrowser: LinkBrowser;
  requireAgentOffThreads: string[];
  load: () => Promise<void>;
  toggleGroup: (groupId: string) => void;
  expandGroup: (groupId: string) => void;
  setUnreadsOnly: (on: boolean) => void;
  setSpeakAloud: (on: boolean) => void;
  rememberEmoji: (ch: string) => void;
  setPreferNativeApps: (on: boolean) => void;
  setLinkBrowser: (browser: LinkBrowser) => void;
  isRequireAgent: (key: string) => boolean;
  setRequireAgent: (key: string, on: boolean) => void;
  toggleRequireAgent: (key: string) => void;
}

function persist(state: PrefsState): void {
  const data: PersistedPrefs = {
    collapsedGroups: Object.keys(state.collapsedGroups),
    unreadsOnly: state.unreadsOnly,
    speakAloud: state.speakAloud,
    recentEmoji: state.recentEmoji,
    preferNativeApps: state.preferNativeApps,
    linkBrowser: state.linkBrowser,
    requireAgentOffThreads: state.requireAgentOffThreads,
  };
  FileSystem.writeAsStringAsync(PREFS_FILE, JSON.stringify(data)).catch(() => {
    /* best-effort */
  });
}

export const usePrefs = create<PrefsState>((set, get) => ({
  loaded: false,
  collapsedGroups: {},
  unreadsOnly: false,
  speakAloud: false,
  recentEmoji: [],
  preferNativeApps: true,
  linkBrowser: "in-app",
  requireAgentOffThreads: [],

  async load() {
    try {
      const text = await FileSystem.readAsStringAsync(PREFS_FILE);
      const data = JSON.parse(text) as Partial<PersistedPrefs>;
      set({
        loaded: true,
        collapsedGroups: Object.fromEntries(
          (data.collapsedGroups ?? []).map((id) => [id, true as const]),
        ),
        unreadsOnly: !!data.unreadsOnly,
        speakAloud: !!data.speakAloud,
        recentEmoji: Array.isArray(data.recentEmoji)
          ? data.recentEmoji.filter((c) => typeof c === "string").slice(0, RECENT_EMOJI_MAX)
          : [],
        preferNativeApps:
          typeof data.preferNativeApps === "boolean"
            ? data.preferNativeApps
            : true,
        linkBrowser: ["in-app", "system", "chrome"].includes(data.linkBrowser ?? "")
          ? data.linkBrowser as LinkBrowser
          : "in-app",
        requireAgentOffThreads: parseRequireAgentKeys(data.requireAgentOffThreads),
      });
    } catch {
      set({ loaded: true }); // first run
    }
  },

  toggleGroup(groupId) {
    const collapsed = { ...get().collapsedGroups };
    if (collapsed[groupId]) delete collapsed[groupId];
    else collapsed[groupId] = true;
    set({ collapsedGroups: collapsed });
    persist(get());
  },

  expandGroup(groupId) {
    if (!get().collapsedGroups[groupId]) return;
    const collapsed = { ...get().collapsedGroups };
    delete collapsed[groupId];
    set({ collapsedGroups: collapsed });
    persist(get());
  },

  setUnreadsOnly(on) {
    set({ unreadsOnly: on });
    persist(get());
  },

  setSpeakAloud(on) {
    set({ speakAloud: on });
    persist(get());
  },

  rememberEmoji(ch) {
    set({
      recentEmoji: [ch, ...get().recentEmoji.filter((c) => c !== ch)].slice(0, RECENT_EMOJI_MAX),
    });
    persist(get());
  },

  setPreferNativeApps(on) {
    set({ preferNativeApps: on });
    persist(get());
  },

  setLinkBrowser(browser) {
    set({ linkBrowser: browser });
    persist(get());
  },

  isRequireAgent(key) {
    return isRequireAgentOn(get().requireAgentOffThreads, key);
  },

  setRequireAgent(key, on) {
    const requireAgentOffThreads = on
      ? forgetRequireAgentOff(get().requireAgentOffThreads, key)
      : rememberRequireAgentOff(get().requireAgentOffThreads, key);
    set({ requireAgentOffThreads });
    persist(get());
  },

  toggleRequireAgent(key) {
    get().setRequireAgent(key, !get().isRequireAgent(key));
  },
}));
