import { create } from "zustand";
import type { UnreadFilter } from "@agora/core";

// Deliberately in memory: a cold start resets the tab to Unreads and the filter to All.
export type InboxTab = "unreads" | "threads" | "approvals" | "drafts";

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
