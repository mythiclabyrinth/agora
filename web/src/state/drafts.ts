import { create } from "zustand";

interface DraftState {
  drafts: Record<string, string>;
  set: (key: string, text: string) => void;
}

export const useDrafts = create<DraftState>((set) => ({
  drafts: {},
  set: (key, text) => set((state) => ({ drafts: { ...state.drafts, [key]: text } })),
}));

export function appendDraft(key: string, text: string): void {
  const clean = text.trim();
  if (!clean) return;
  const current = useDrafts.getState().drafts[key] ?? "";
  useDrafts.getState().set(key, current + (current && !/\s$/.test(current) ? " " : "") + clean);
}
