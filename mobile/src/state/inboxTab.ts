import { create } from "zustand";
import type { UnreadFilter } from "@agora/core";

export type InboxTab = "unreads" | "threads";

interface InboxTabState {
  tab: InboxTab;
  filter: UnreadFilter;
  setTab: (tab: InboxTab) => void;
  setFilter: (filter: UnreadFilter) => void;
}

export const useInboxTab = create<InboxTabState>(set => ({
  tab: "unreads",
  filter: "all",
  setTab: tab => set({ tab }),
  setFilter: filter => set({ filter }),
}));
