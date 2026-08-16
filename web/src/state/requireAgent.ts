/* Sticky per-thread "require agent" toggle for the thread composer. Stores
   only the conversation keys that are ON (absence = off), LRU-capped, under
   agora_thread_require_agent — same key shape as Talk-to (`threadAddressKey`). */

import { create } from "zustand";
import {
  disableRequireAgent,
  enableRequireAgent,
  parseRequireAgentKeys,
} from "@agora/core";

const STORAGE_KEY = "agora_thread_require_agent";

function readKeys(): string[] {
  try {
    return parseRequireAgentKeys(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"));
  } catch {
    return [];
  }
}

function writeKeys(keys: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
  } catch {
    /* full / private mode */
  }
}

interface RequireAgentState {
  /** Conversation keys (`threadAddressKey`) where the toggle is on. */
  onKeys: string[];
  isOn: (key: string) => boolean;
  setOn: (key: string, on: boolean) => void;
  toggle: (key: string) => void;
  resetAll: () => void;
}

export const useRequireAgent = create<RequireAgentState>((set, get) => ({
  onKeys: typeof localStorage === "undefined" ? [] : readKeys(),

  isOn: (key) => get().onKeys.includes(key),

  setOn: (key, on) => {
    const onKeys = on
      ? enableRequireAgent(get().onKeys, key)
      : disableRequireAgent(get().onKeys, key);
    writeKeys(onKeys);
    set({ onKeys });
  },

  toggle: (key) => get().setOn(key, !get().isOn(key)),

  resetAll: () => {
    writeKeys([]);
    set({ onKeys: [] });
  },
}));
