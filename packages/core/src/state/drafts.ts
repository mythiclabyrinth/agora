import { create } from "zustand";

export interface DraftMeta { addressed: string[]; reply_in_thread: boolean }
export const emptyDraftMeta = (): DraftMeta => ({ addressed: [], reply_in_thread: false });
export interface DraftRow {
  channel_id: string;
  thread_id: number | null;
  body: string;
  meta: DraftMeta;
  rev: number;
  client_id: string;
  updated_at: number;
  channel_name: string;
  group_id: string;
  group_name: string;
  thread_title: string | null;
}
export interface DraftPayload extends Omit<DraftRow, "body" | "channel_name" | "group_id" | "group_name" | "thread_title"> {
  body: string | null;
}
export interface DraftEvent extends DraftPayload { type: "draft" }
export interface DraftSendOutcome { deleted: boolean; row: DraftPayload | null }
interface DraftState {
  byConvo: Record<string, string>;
  metaByConvo: Record<string, DraftMeta>;
  metaRevByConvo: Record<string, number>;
  rows: DraftRow[];
  loading: boolean;
  loadError: boolean;
  setDraft: (key: string, text: string) => void;
  setMeta: (key: string, meta: DraftMeta) => void;
  setRemoteMeta: (key: string, meta: DraftMeta) => void;
  setRows: (rows: DraftRow[]) => void;
  removeRow: (key: string) => void;
  clear: (key: string) => void;
  resetAll: () => void;
}

export const useMessageDrafts = create<DraftState>((set) => ({
  byConvo: {}, metaByConvo: {}, metaRevByConvo: {}, rows: [], loading: false, loadError: false,
  setDraft: (key, text) => set(s => { const drafts = { ...s.byConvo }; if (text) drafts[key] = text; else delete drafts[key]; return { byConvo: drafts }; }),
  setMeta: (key, meta) => set(s => ({ metaByConvo: { ...s.metaByConvo, [key]: meta } })),
  setRemoteMeta: (key, meta) => set(s => ({
    metaByConvo: { ...s.metaByConvo, [key]: meta },
    metaRevByConvo: { ...s.metaRevByConvo, [key]: (s.metaRevByConvo[key] ?? 0) + 1 },
  })),
  setRows: rows => set({ rows }),
  removeRow: key => set(s => ({ rows: s.rows.filter(row => draftKey(row.channel_id, row.thread_id) !== key) })),
  clear: key => set(s => {
    if (!(key in s.byConvo)) return s;
    const byConvo = { ...s.byConvo }; delete byConvo[key];
    return { byConvo };
  }),
  resetAll: () => set({ byConvo: {}, metaByConvo: {}, metaRevByConvo: {}, rows: [], loading: false, loadError: false }),
}));

export function draftKey(channelId: string, threadId: number | null): string {
  return threadId == null ? channelId : `${channelId}:t${threadId}`;
}
