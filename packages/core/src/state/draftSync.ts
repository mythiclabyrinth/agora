import type { ApiClient } from "../api/client";
import { ApiError } from "../api/client";
import { draftKey, emptyDraftMeta, useMessageDrafts, type DraftEvent, type DraftMeta, type DraftRow } from "./drafts";
import { useAddressed } from "./addressed";

interface KeyState {
  seenRev: number;
  baseRev: number;
  baseText: string;
  baseMeta: DraftMeta;
  dirty: boolean;
  blocked: boolean;
  firstEdit: number;
  editSeq: number;
  timer?: ReturnType<typeof setTimeout>;
  saving?: Promise<void>;
  deferred?: DraftEvent | DraftRow;
}
const sameMeta = (a: DraftMeta, b: DraftMeta) => a.reply_in_thread === b.reply_in_thread &&
  JSON.stringify(a.addressed) === JSON.stringify(b.addressed);
const same = (a: string, am: DraftMeta, b: string, bm: DraftMeta) => a === b && sameMeta(am, bm);
const parseKey = (key: string) => {
  const match = key.match(/^(.*):t(\d+)$/);
  return { channel_id: match ? match[1] : key, thread_id: match ? Number(match[2]) : null };
};

class DraftSync {
  readonly clientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  private api?: ApiClient;
  private enabled = false;
  private keys = new Map<string, KeyState>();
  private current?: string;
  private hydrateEpoch = 0;
  private state(key: string): KeyState {
    let s = this.keys.get(key);
    if (!s) { s = { seenRev: 0, baseRev: 0, baseText: "", baseMeta: emptyDraftMeta(), dirty: false, blocked: false, firstEdit: 0, editSeq: 0 }; this.keys.set(key, s); }
    return s;
  }
  private refresh() { void this.hydrate().catch(() => {}); }
  configure(api: ApiClient, enabled: boolean) {
    if (this.api && this.api !== api) this.resetAll();
    this.api = api;
    this.enabled = enabled;
    if (enabled) { this.refresh(); this.flushAll(); }
  }
  resetAll() {
    for (const s of this.keys.values()) if (s.timer) clearTimeout(s.timer);
    this.keys.clear(); this.api = undefined; this.enabled = false; this.current = undefined;
    this.hydrateEpoch++;
    useMessageDrafts.getState().resetAll();
  }
  private meta(key: string): DraftMeta {
    return useMessageDrafts.getState().metaByConvo[key] ?? emptyDraftMeta();
  }
  private text(key: string): string { return useMessageDrafts.getState().byConvo[key] ?? ""; }
  revision(key: string): number { return this.state(key).baseRev; }
  version(key: string): number { return this.state(key).editSeq; }
  setActive(key: string) {
    if (this.current && this.current !== key) void this.flush(this.current);
    this.current = key;
  }
  edit(key: string, text: string, meta: DraftMeta = this.meta(key)) {
    const changed = !same(text, meta, this.text(key), this.meta(key));
    useMessageDrafts.getState().setDraft(key, text);
    useMessageDrafts.getState().setMeta(key, meta);
    const s = this.state(key);
    if (changed) s.blocked = false;
    s.editSeq++;
    s.dirty = !same(text, meta, s.baseText, s.baseMeta);
    if (s.dirty && !s.blocked) this.schedule(key);
    else if (s.deferred && s.deferred.rev > s.baseRev) {
      if (s.timer) { clearTimeout(s.timer); s.timer = undefined; }
      const deferred = s.deferred; s.deferred = undefined; s.seenRev = s.baseRev;
      this.apply(deferred, false);
    }
  }
  editMeta(key: string, meta: DraftMeta) {
    if (!sameMeta(this.meta(key), meta)) this.state(key).blocked = false;
    useMessageDrafts.getState().setMeta(key, meta);
    if (this.text(key).trim()) this.edit(key, this.text(key), meta);
  }
  private schedule(key: string) {
    const s = this.state(key);
    if (s.timer) clearTimeout(s.timer);
    if (!this.enabled || s.blocked) return;
    if (!s.firstEdit) s.firstEdit = Date.now();
    s.timer = setTimeout(() => { s.timer = undefined; void this.flush(key); }, Math.max(0, Math.min(800, 5000 - (Date.now() - s.firstEdit))));
  }
  async flush(key: string): Promise<void> {
    const s = this.state(key);
    if (s.timer) { clearTimeout(s.timer); s.timer = undefined; }
    if (!this.enabled || !this.api || s.blocked || !s.dirty) return;
    if (s.saving) { await s.saving; if (s.dirty) await this.flush(key); return; }
    const text = this.text(key), meta = this.meta(key), api = this.api, editSeq = s.editSeq;
    let saved = false;
    const run = async () => {
      try {
        const row = await api.put<DraftEvent>("/api/drafts", { ...parseKey(key), body: text, meta, client_id: this.clientId });
        saved = true;
        if (row.rev > s.seenRev) s.seenRev = row.rev;
        s.baseRev = row.rev; s.baseText = text; s.baseMeta = meta;
        s.dirty = !same(this.text(key), this.meta(key), text, meta);
        if (row.body === null) useMessageDrafts.getState().setRows(useMessageDrafts.getState().rows.filter(r => draftKey(r.channel_id, r.thread_id) !== key));
        this.refresh();
      } catch (e) {
        // Stop retrying this version; a changed draft can try again.
        if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429 && s.editSeq === editSeq) s.blocked = true;
      } finally { s.firstEdit = 0; }
    };
    s.saving = run().finally(() => { s.saving = undefined; });
    await s.saving;
    if (s.deferred && !s.dirty && s.deferred.rev > s.baseRev) {
      const deferred = s.deferred;
      s.deferred = undefined;
      s.seenRev = s.baseRev;
      this.apply(deferred, false);
    }
    if (s.deferred && s.deferred.rev <= s.baseRev) s.deferred = undefined;
    // A failed request stays dirty but does not start an endless retry loop.
    if (s.dirty && !s.blocked && (saved || s.editSeq !== editSeq)) this.schedule(key);
  }
  flushAll() {
    for (const [key, state] of this.keys) if (state.dirty) void this.flush(key);
  }
  async hydrate(): Promise<void> {
    if (!this.enabled || !this.api) return;
    const epoch = ++this.hydrateEpoch;
    useMessageDrafts.setState({ loading: true });
    let rows: DraftRow[];
    try { rows = (await this.api.get<{ items: DraftRow[] }>("/api/drafts")).items; }
    catch (error) {
      if (epoch === this.hydrateEpoch) useMessageDrafts.setState({ loading: false, loadError: true });
      throw error;
    }
    if (epoch !== this.hydrateEpoch) return;
    useMessageDrafts.setState({ rows, loading: false, loadError: false });
    const found = new Set<string>();
    for (const row of rows) {
      const key = draftKey(row.channel_id, row.thread_id); found.add(key);
      this.apply(row, false);
    }
    for (const [key, s] of this.keys) {
      if (!found.has(key) && !s.dirty && !s.saving && !s.blocked && s.baseText) {
        s.baseText = ""; s.baseMeta = emptyDraftMeta();
        useMessageDrafts.getState().clear(key);
      }
    }
  }
  applyRemote(row: DraftEvent) {
    if (row.client_id === this.clientId) return;
    this.hydrateEpoch++;
    this.apply(row, true);
    this.refresh();
  }
  private apply(row: DraftEvent | DraftRow, remote: boolean) {
    const key = draftKey(row.channel_id, row.thread_id), s = this.state(key);
    if (row.rev <= s.seenRev) return;
    s.seenRev = row.rev;
    if (s.dirty || s.saving) { s.deferred = row; return; }
    s.baseRev = row.rev;
    s.baseText = row.body ?? "";
    if (row.body === null) {
      // A discarded message should not erase this device's sticky composer choices.
      s.baseMeta = { ...this.meta(key), addressed: useAddressed.getState().byConvo[key] ?? this.meta(key).addressed };
      useMessageDrafts.getState().clear(key);
    } else {
      s.baseMeta = { ...emptyDraftMeta(), ...row.meta };
      useMessageDrafts.getState().setDraft(key, row.body);
      useAddressed.getState().replace(key, s.baseMeta.addressed);
    }
    useMessageDrafts.getState().setMeta(key, s.baseMeta);
    if (remote && row.body === null) useMessageDrafts.getState().setRows(useMessageDrafts.getState().rows.filter(r => draftKey(r.channel_id, r.thread_id) !== key));
  }
  prepareSend(key: string): number {
    const s = this.state(key);
    if (s.timer) { clearTimeout(s.timer); s.timer = undefined; }
    return s.baseRev;
  }
  clearForSend(key: string, sentText: string, sentVersion: number) {
    const s = this.state(key);
    if (s.editSeq === sentVersion && this.text(key) === sentText) useMessageDrafts.getState().clear(key);
  }
  restoreFailedSend(key: string, sentText: string, _sentVersion: number) {
    const current = this.text(key);
    if (current === "") this.edit(key, sentText);
    else if (current && sentText && !current.includes(sentText)) {
      const separator = /\s$/.test(sentText) || /^\s/.test(current) ? "" : " ";
      this.edit(key, sentText + separator + current);
    }
  }
  async onSent(key: string, sentText: string, sentVersion = this.version(key)) {
    const s = this.state(key);
    if ((this.text(key) !== sentText && this.text(key) !== "") || s.editSeq !== sentVersion) return;
    useMessageDrafts.getState().clear(key);
    useMessageDrafts.getState().setMeta(key, { ...this.meta(key), reply_in_thread: false });
    s.dirty = false; s.blocked = false;
    if (s.saving) await s.saving;
    if (this.text(key) !== "" || s.editSeq !== sentVersion) return;
    if (s.timer) { clearTimeout(s.timer); s.timer = undefined; }
    s.dirty = false;
    if (!this.enabled || !this.api) return;
    try {
      const response = await this.api.delete<{ draft: DraftEvent | null }>("/api/drafts", { ...parseKey(key), if_rev: s.baseRev, client_id: this.clientId });
      if (response.draft && response.draft.rev > s.seenRev) {
        s.seenRev = response.draft.rev; s.baseRev = response.draft.rev;
        s.baseText = ""; s.baseMeta = emptyDraftMeta();
      }
    } catch { /* The message succeeded; keep the composer clear if cleanup fails. */ }
    this.refresh();
  }
  async discard(key: string, ifRev?: number): Promise<boolean> {
    if (!this.enabled || !this.api) return false;
    const s = this.state(key);
    if (s.timer) { clearTimeout(s.timer); s.timer = undefined; }
    if (s.saving) await s.saving;
    if (s.timer) { clearTimeout(s.timer); s.timer = undefined; }
    const response = await this.api.delete<{ deleted: boolean; draft: DraftEvent | null }>("/api/drafts", {
      ...parseKey(key), ...(ifRev === undefined ? {} : { if_rev: ifRev }), client_id: this.clientId,
    });
    if (!response.deleted) {
      await this.hydrate().catch(() => {});
      if (s.dirty && !s.blocked) this.schedule(key);
      return false;
    }
    if (response.draft && response.draft.rev <= s.seenRev) {
      await this.hydrate().catch(() => {});
      return false;
    }
    s.dirty = false; s.blocked = false;
    if (response.draft) this.apply(response.draft, false);
    useMessageDrafts.getState().clear(key);
    useMessageDrafts.getState().setRows(useMessageDrafts.getState().rows.filter(r => draftKey(r.channel_id, r.thread_id) !== key));
    return true;
  }
}

export const draftSync = new DraftSync();
