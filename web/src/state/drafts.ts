import { draftSync, useMessageDrafts } from "@agora/core";

export const useDrafts = useMessageDrafts;

export function appendDraft(key: string, text: string): void {
  const clean = text.trim();
  if (!clean) return;
  const current = useMessageDrafts.getState().byConvo[key] ?? "";
  draftSync.edit(key, current + (current && !/\s$/.test(current) ? " " : "") + clean);
}
