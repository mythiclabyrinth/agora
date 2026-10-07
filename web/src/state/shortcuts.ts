import { create } from "zustand";
import { currentPlatform, findConflicts, SHORTCUTS, type Conflict, type Platform } from "@agora/core";
import { isDesktopShell } from "../lib/chime";
import { useUiState } from "./ui";

const STORAGE_KEY = "agora_shortcuts";
export type Bindings = Record<string, string | null>;

export function loadSavedBindings(): Bindings {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const platform = currentPlatform();
    const candidate: Bindings = {};
    for (const shortcut of SHORTCUTS) {
      const combo = raw[shortcut.id];
      if ((combo === null || typeof combo === "string") && shortcut.rebindable) candidate[shortcut.id] = combo;
    }
    const valid: Bindings = { ...candidate };
    for (const shortcut of SHORTCUTS) {
      const combo = valid[shortcut.id];
      if (typeof combo === "string" &&
        findConflicts(shortcut.id, combo, platform, valid, isDesktopShell()).some(c => c.kind === "blocked" || c.kind === "duplicate")) delete valid[shortcut.id];
    }
    return valid;
  } catch { return {}; }
}
function persist(bindings: Bindings) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings)); } catch { /* private storage */ }
}

interface ShortcutState {
  bindings: Bindings;
  sheetOpen: boolean;
  setSheetOpen: (open: boolean) => void;
  setBinding: (id: string, combo: string | null, replaceId?: string) => void;
  resetBinding: (id: string, replaceId?: string) => Conflict | null;
  resetAll: () => void;
}
export const useShortcutState = create<ShortcutState>((set, get) => ({
  bindings: loadSavedBindings(), sheetOpen: false,
  setSheetOpen: sheetOpen => {
    if (sheetOpen) useUiState.setState({ searchOpen: false, panel: null });
    set({ sheetOpen });
  },
  setBinding: (id, combo, replaceId) => {
    const bindings = { ...get().bindings, [id]: combo };
    if (replaceId) bindings[replaceId] = null;
    persist(bindings); set({ bindings });
  },
  resetBinding: (id, replaceId) => {
    const bindings = { ...get().bindings };
    const defaultCombo = SHORTCUTS.find(s => s.id === id)?.keys[currentPlatform()];
    if (defaultCombo) {
      const conflict = findConflicts(id, defaultCombo, currentPlatform(), bindings,
        isDesktopShell())
        .find(c => c.kind === "blocked" || (c.kind === "duplicate" && c.withId !== replaceId));
      if (conflict) return conflict;
    }
    delete bindings[id];
    if (replaceId) bindings[replaceId] = null;
    persist(bindings); set({ bindings });
    return null;
  },
  resetAll: () => { persist({}); set({ bindings: {} }); },
}));
export function bindingFor(id: string, platform: Platform): string | undefined {
  const override = useShortcutState.getState().bindings[id];
  return override === undefined ? SHORTCUTS.find(s => s.id === id)?.keys[platform] : override ?? undefined;
}
