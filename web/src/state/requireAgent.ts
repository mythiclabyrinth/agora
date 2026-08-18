/* Sticky per-thread "require agent" toggle for the thread composer. The
   toggle is ON by default, so this stores only the *exceptions* — keys the
   user switched OFF (absence = on) — LRU-capped, under
   agora_thread_require_agent_off. The storage key is deliberately new: the
   old agora_thread_require_agent blob held ON keys, and reusing it would
   invert every saved choice. Same key shape as Talk-to (`threadAddressKey`). */

import { create } from "zustand";
import {
  forgetRequireAgentOff,
  isRequireAgentOn,
  parseRequireAgentKeys,
  rememberRequireAgentOff,
} from "@agora/core";

const STORAGE_KEY = "agora_thread_require_agent_off";

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
  /** Conversation keys (`threadAddressKey`) where the toggle was switched off. */
  offKeys: string[];
  isOn: (key: string) => boolean;
  setOn: (key: string, on: boolean) => void;
  toggle: (key: string) => void;
  resetAll: () => void;
}

export const useRequireAgent = create<RequireAgentState>((set, get) => ({
  offKeys: typeof localStorage === "undefined" ? [] : readKeys(),

  isOn: (key) => isRequireAgentOn(get().offKeys, key),

  setOn: (key, on) => {
    const offKeys = on
      ? forgetRequireAgentOff(get().offKeys, key)
      : rememberRequireAgentOff(get().offKeys, key);
    writeKeys(offKeys);
    set({ offKeys });
  },

  toggle: (key) => get().setOn(key, !get().isOn(key)),

  resetAll: () => {
    writeKeys([]);
    set({ offKeys: [] });
  },
}));
