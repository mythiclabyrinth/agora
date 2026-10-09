import type { ApiClient } from "../api/client";
import { ApiError } from "../api/client";
import { draftKey, emptyDraftMeta, useMessageDrafts, type DraftEvent, type DraftMeta, type DraftPayload, type DraftRow, type DraftSendOutcome } from "./drafts";
import { useAddressed } from "./addressed";

interface KeyState {
  seenRev: number;
  baseRev: number;
  baseText: string;
  baseMeta: DraftMeta;
  baseOwn: boolean;
  discardedRev?: number;
  dirty: boolean;
  blocked: boolean;
  blockedStatus?: number;
  firstEdit: number;
  editSeq: number;
  textSeq: number;
  retryCount: number;
  timer?: ReturnType<typeof setTimeout>;
  saving?: Promise<void>;
  cleanupRev?: number;
  cleanupRetries: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  cleanupSaving?: Promise<void>;
  deferred?: DraftPayload | DraftRow;
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
  private generation = 0;
  private state(key: string): KeyState {
    let s = this.keys.get(key);
    if (!s) { s = { seenRev: 0, baseRev: 0, baseText: "", baseMeta: emptyDraftMeta(), baseOwn: false, dirty: false, blocked: false, firstEdit: 0, editSeq: 0, textSeq: 0, retryCount: 0, cleanupRetries: 0 }; this.keys.set(key, s); }
    return s;
  }
  private refresh() { void this.hydrate().catch(() => {}); }
  configure(api: ApiClient, enabled: boolean) {
    // Session owners reset when the account or server changes; a renewed token
    // for the same account must keep unsynced text and its revision history.
    if (this.api && this.api !== api) for (const s of this.keys.values()) {
      if (s.blockedStatus === 403) { s.blocked = false; s.blockedStatus = undefined; }
    }
    this.api = api;
    this.enabled = enabled;
    if (enabled) { this.refresh(); this.flushAll(); }
  }
  resetAll() {
    this.generation++;
    for (const s of this.keys.values()) {
      if (s.timer) clearTimeout(s.timer);
      if (s.cleanupTimer) clearTimeout(s.cleanupTimer);
    }
    this.keys.clear(); this.api = undefined; this.enabled = false; this.current = undefined;
    this.hydrateEpoch++;
    useMessageDrafts.getState().resetAll();
  }
  private meta(key: string): DraftMeta {
    return useMessageDrafts.getState().metaByConvo[key] ?? emptyDraftMeta();
  }
  private text(key: string): string { return useMessageDrafts.getState().byConvo[key] ?? ""; }
  version(key: string): number { return this.state(key).textSeq; }
  setActive(key: string) {
    if (this.current && this.current !== key) void this.flush(this.current);
    this.current = key;
  }
  edit(key: string, text: string, meta: DraftMeta = this.meta(key)) {
    const textChanged = text !== this.text(key);
    const metaChanged = !sameMeta(meta, this.meta(key));
    const changed = textChanged || metaChanged;
    useMessageDrafts.getState().setDraft(key, text);
    if (metaChanged) useMessageDrafts.getState().setMeta(key, meta);
    const s = this.state(key);
    if (changed) { s.blocked = false; s.blockedStatus = undefined; s.retryCount = 0; }
    if (changed) s.editSeq++;
    if (textChanged) s.textSeq++;
    s.dirty = !same(text, meta, s.baseText, s.baseMeta);
    if (s.dirty && !s.blocked) this.schedule(key);
    else this.settle(key, s);
  }
  editMeta(key: string, meta: DraftMeta) {
    if (sameMeta(this.meta(key), meta)) return;
    if (this.text(key).trim()) { this.edit(key, this.text(key), meta); return; }
    const s = this.state(key);
    s.blocked = false; s.blockedStatus = undefined; s.retryCount = 0;
    s.editSeq++;
    useMessageDrafts.getState().setMeta(key, meta);
    if (s.dirty) this.schedule(key);
  }
  private schedule(key: string) {
    const s = this.state(key);
    if (s.timer) clearTimeout(s.timer);
    if (!this.enabled || s.blocked) return;
    if (!s.firstEdit) s.firstEdit = Date.now();
    s.timer = setTimeout(() => { s.timer = undefined; void this.flush(key); }, Math.max(0, Math.min(800, 5000 - (Date.now() - s.firstEdit))));
  }
  private scheduleRetry(key: string) {
    const s = this.state(key);
    if (s.timer) clearTimeout(s.timer);
    if (!this.enabled || s.blocked) return;
    const delay = Math.min(60_000, 2000 * 2 ** Math.min(s.retryCount - 1, 5));
    s.timer = setTimeout(() => { s.timer = undefined; void this.flush(key); }, delay);
  }
  private scheduleCleanupRetry(key: string, s: KeyState, rev: number) {
    s.cleanupRev = rev;
    if (s.cleanupTimer) clearTimeout(s.cleanupTimer);
    if (!this.enabled || !this.api) return;
    const delay = Math.min(60_000, 2000 * 2 ** Math.min(s.cleanupRetries++, 5));
    const generation = this.generation;
    s.cleanupTimer = setTimeout(() => {
      if (generation !== this.generation) return;
      s.cleanupTimer = undefined;
      void this.retryCleanup(key);
    }, delay);
  }
  private async retryCleanup(key: string) {
    const s = this.state(key), rev = s.cleanupRev, api = this.api, generation = this.generation;
    if (rev === undefined || !this.enabled || !api || s.cleanupSaving) return;
    s.cleanupSaving = (async () => {
      try {
        const result = await api.delete<{ deleted: boolean; draft: DraftPayload | null }>("/api/drafts", {
          ...parseKey(key), if_rev: rev, client_id: this.clientId,
        });
        if (generation !== this.generation || s.cleanupRev !== rev) return;
        s.cleanupRev = undefined; s.cleanupRetries = 0;
        if (result.draft) {
          s.baseRev = Math.max(s.baseRev, result.draft.rev);
          s.seenRev = Math.max(s.seenRev, result.draft.rev);
        }
        this.refresh();
      } catch (error) {
        if (generation !== this.generation || s.cleanupRev !== rev) return;
        if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
          s.cleanupRev = undefined;
        } else this.scheduleCleanupRetry(key, s, rev);
      }
    })().finally(() => { s.cleanupSaving = undefined; });
    await s.cleanupSaving;
  }
  private settle(key: string, s: KeyState) {
    if (!s.deferred || s.dirty || s.saving) return;
    const deferred = s.deferred;
    s.deferred = undefined;
    if (deferred.rev <= s.baseRev) return;
    if (s.timer) { clearTimeout(s.timer); s.timer = undefined; }
    s.seenRev = s.baseRev;
    this.apply(deferred, false);
  }
  private unblockAuth(s: KeyState) {
    if (s.blockedStatus === 401) {
      s.blocked = false;
      s.blockedStatus = undefined;
    }
  }
  retryForbidden() {
    for (const s of this.keys.values()) {
      if (s.blockedStatus === 403) { s.blocked = false; s.blockedStatus = undefined; }
    }
    this.flushAll();
  }
  async flush(key: string, options?: { keepalive?: boolean }): Promise<void> {
    const s = this.state(key);
    const generation = this.generation;
    const configuredApi = this.api;
    if (s.timer) { clearTimeout(s.timer); s.timer = undefined; }
    if (!this.enabled || !this.api || s.blocked || !s.dirty) {
      if (!s.dirty) this.settle(key, s);
      return;
    }
    if (s.saving) {
      await s.saving;
      if (generation !== this.generation) return;
      if (configuredApi !== this.api) this.unblockAuth(s);
      if (s.dirty) await this.flush(key, options);
      else this.settle(key, s);
      return;
    }
    const text = this.text(key), meta = this.meta(key), api = this.api, editSeq = s.editSeq;
    let saved = false;
    const run = async () => {
      try {
        const payload = { ...parseKey(key), body: text, meta, client_id: this.clientId };
        const row = options
          ? await api.put<DraftEvent>("/api/drafts", payload, options)
          : await api.put<DraftEvent>("/api/drafts", payload);
        if (generation !== this.generation) return;
        saved = true;
        s.retryCount = 0;
        if (row.rev > s.seenRev) s.seenRev = row.rev;
        if (row.rev >= s.baseRev) {
          s.baseRev = row.rev; s.baseText = text; s.baseMeta = meta; s.baseOwn = row.body !== null;
          s.dirty = !same(this.text(key), this.meta(key), text, meta);
        }
        if (row.body === null) useMessageDrafts.getState().removeRow(key);
        this.refresh();
      } catch (e) {
        if (generation !== this.generation) return;
        // Stop retrying this version; a changed draft can try again.
        if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429 && s.editSeq === editSeq) {
          s.blocked = true;
          s.blockedStatus = e.status;
        }
        if (!s.blocked) s.retryCount++;
      } finally { if (generation === this.generation) s.firstEdit = 0; }
    };
    s.saving = run().finally(() => { s.saving = undefined; });
    await s.saving;
    if (generation !== this.generation) return;
    if (api !== this.api) this.unblockAuth(s);
    this.settle(key, s);
    // A failed request stays dirty but does not start an endless retry loop.
    if (s.dirty && !s.blocked) {
      if (saved || s.editSeq !== editSeq || api !== this.api) this.schedule(key);
      else this.scheduleRetry(key);
    }
  }
  flushAll(options?: { keepalive?: boolean }) {
    let keepaliveBytes = 0;
    for (const [key, state] of this.keys) {
      this.unblockAuth(state);
      if (!options?.keepalive && state.cleanupRev !== undefined) {
        if (state.cleanupTimer) { clearTimeout(state.cleanupTimer); state.cleanupTimer = undefined; }
        void this.retryCleanup(key);
      }
      if (!this.enabled || !this.api || !state.dirty || state.blocked) continue;
      if (options?.keepalive && state.saving) continue;
      let requestOptions = options;
      if (options?.keepalive) {
        const body = JSON.stringify({ ...parseKey(key), body: this.text(key), meta: this.meta(key), client_id: this.clientId });
        const bytes = new Blob([body]).size;
        if (keepaliveBytes + bytes <= 60 * 1024) {
          keepaliveBytes += bytes;
          requestOptions = { keepalive: true };
        } else requestOptions = undefined;
      }
      void this.flush(key, requestOptions);
    }
  }
  async hydrate(retryDeniedDiscards = false): Promise<void> {
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
    // A denied discard is retried only after a forced visibility refresh.
    if (retryDeniedDiscards) {
      const kept: DraftRow[] = [];
      for (const row of rows) {
        const key = draftKey(row.channel_id, row.thread_id), s = this.keys.get(key);
        if (s?.discardedRev === row.rev) {
          try {
            const result = await this.api.delete<{ deleted: boolean; draft: DraftPayload | null }>("/api/drafts", {
              ...parseKey(key), if_rev: row.rev, client_id: this.clientId,
            });
            if (epoch !== this.hydrateEpoch) return;
            if (result.deleted) {
              s.discardedRev = undefined;
              if (result.draft) { s.baseRev = Math.max(s.baseRev, result.draft.rev); s.seenRev = Math.max(s.seenRev, result.draft.rev); }
              s.baseText = ""; s.baseOwn = false;
              continue;
            }
            this.refresh();
            return;
          } catch { /* Access may still be denied; retry on a later visibility refresh. */ }
          continue;
        }
        if (s?.discardedRev !== undefined && row.rev > s.discardedRev) s.discardedRev = undefined;
        kept.push(row);
      }
      rows = kept;
    }
    useMessageDrafts.setState({ rows, loading: false, loadError: false });
    const found = new Set<string>();
    for (const row of rows) {
      const key = draftKey(row.channel_id, row.thread_id); found.add(key);
      this.apply(row, false);
    }
    for (const [key, s] of this.keys) {
      if (!found.has(key) && !s.dirty && !s.saving && !s.blocked && s.baseText) {
        s.seenRev = s.baseRev = Math.max(0, s.seenRev - 1);
        s.baseText = "";
        s.baseOwn = false;
        s.baseMeta = { ...this.meta(key), addressed: useAddressed.getState().byConvo[key] ?? this.meta(key).addressed };
        s.deferred = undefined;
        useMessageDrafts.getState().clear(key);
        useMessageDrafts.getState().setMeta(key, s.baseMeta);
      }
    }
  }
  applyRemote(row: DraftEvent) {
    if (row.client_id === this.clientId) return;
    this.hydrateEpoch++;
    this.apply(row, true);
    this.refresh();
  }
  private apply(row: DraftPayload | DraftRow, remote: boolean) {
    const key = draftKey(row.channel_id, row.thread_id), s = this.state(key);
    if (row.rev <= s.seenRev) return;
    s.seenRev = row.rev;
    if (s.dirty || s.saving) { s.deferred = row; return; }
    s.baseRev = row.rev;
    s.baseText = row.body ?? "";
    s.baseOwn = false;
    if (row.body === null) {
      // A discarded message should not erase this device's sticky composer choices.
      s.baseMeta = { ...this.meta(key), addressed: useAddressed.getState().byConvo[key] ?? this.meta(key).addressed };
      useMessageDrafts.getState().clear(key);
    } else {
      s.baseMeta = { ...emptyDraftMeta(), ...row.meta };
      useMessageDrafts.getState().setDraft(key, row.body);
      useAddressed.getState().replace(key, s.baseMeta.addressed);
    }
    useMessageDrafts.getState().setRemoteMeta(key, s.baseMeta);
    if (remote && row.body === null) useMessageDrafts.getState().removeRow(key);
  }
  prepareSend(key: string): number {
    const s = this.state(key);
    if (s.timer) { clearTimeout(s.timer); s.timer = undefined; }
    return s.baseRev;
  }
  clearForSend(key: string, sentText: string, sentVersion: number) {
    const s = this.state(key);
    if (s.textSeq === sentVersion && this.text(key) === sentText) useMessageDrafts.getState().clear(key);
  }
  restoreFailedSend(key: string, sentText: string, _sentVersion: number) {
    const current = this.text(key);
    if (current === "") this.edit(key, sentText);
    else if (current && sentText && !current.includes(sentText)) {
      const separator = /\s$/.test(sentText) || /^\s/.test(current) ? "" : " ";
      this.edit(key, sentText + separator + current);
    }
  }
  async onSent(key: string, sentText: string, sentVersion = this.version(key),
    outcome?: DraftSendOutcome) {
    const s = this.state(key);
    const generation = this.generation;
    if ((this.text(key) !== sentText && this.text(key) !== "") || s.textSeq !== sentVersion) {
      this.settle(key, s);
      return;
    }
    useMessageDrafts.getState().clear(key);
    s.dirty = false; s.blocked = false; s.blockedStatus = undefined;
    if (s.saving) await s.saving;
    if (generation !== this.generation) return;
    if (this.text(key) !== "" || s.textSeq !== sentVersion) {
      this.settle(key, s);
      return;
    }
    if (s.timer) { clearTimeout(s.timer); s.timer = undefined; }
    s.dirty = false;
    if (!this.enabled || !this.api) { this.settle(key, s); return; }
    const row = outcome?.row;
    if (row && row.rev > s.baseRev) s.baseRev = row.rev;
    if (row && row.rev > s.seenRev) s.seenRev = row.rev;
    const ownStale = row?.body != null && row.client_id === this.clientId;
    const laterOwnSave = s.baseOwn && s.baseRev > (row?.rev ?? 0) && s.baseText !== "";
    if (ownStale || laterOwnSave) {
      const ifRev = s.baseRev;
      // A PUT that landed after the post can leave the sent text live. One
      // revision-checked delete is enough; an unseen newer edit is preserved.
      try {
        const deleted = await this.api.delete<{ deleted: boolean; draft: DraftPayload | null }>("/api/drafts", {
          ...parseKey(key), if_rev: ifRev, client_id: this.clientId,
        });
        if (generation !== this.generation) return;
        if (deleted.deleted && deleted.draft && deleted.draft.rev > s.baseRev) {
          s.baseRev = deleted.draft.rev; s.seenRev = Math.max(s.seenRev, deleted.draft.rev);
        }
        if (!deleted.deleted) this.refresh();
      } catch (error) {
        if (generation !== this.generation) return;
        // The send succeeded. Keep its text out of the composer while retrying
        // only the conditional cleanup of this revision.
        if (!(error instanceof ApiError) || error.status >= 500 || error.status === 408 || error.status === 429)
          this.scheduleCleanupRetry(key, s, ifRev);
      }
      if (this.text(key) !== "" || s.textSeq !== sentVersion) {
        s.baseText = ""; s.baseOwn = false;
        s.baseMeta = emptyDraftMeta();
        s.dirty = true;
        this.schedule(key);
        this.refresh();
        return;
      }
    } else if (row && !outcome.deleted && row.client_id !== this.clientId && row.rev > s.baseRev - 1) {
      s.seenRev = Math.min(s.seenRev, row.rev - 1);
      this.apply(row, false);
      this.settle(key, s);
      this.refresh();
      return;
    }
    s.baseText = "";
    s.baseOwn = false;
    s.baseMeta = this.meta(key);
    s.dirty = false;
    this.settle(key, s);
    this.refresh();
  }
  async discard(key: string, ifRev?: number): Promise<boolean> {
    if (!this.enabled || !this.api) return false;
    const s = this.state(key);
    const generation = this.generation;
    if (s.timer) { clearTimeout(s.timer); s.timer = undefined; }
    if (s.saving) await s.saving;
    if (generation !== this.generation) return false;
    if (s.timer) { clearTimeout(s.timer); s.timer = undefined; }
    const textSeq = s.textSeq;
    let response: { deleted: boolean; draft: DraftEvent | null };
    try {
      response = await this.api.delete("/api/drafts", {
        ...parseKey(key), ...(ifRev === undefined ? {} : { if_rev: ifRev }), client_id: this.clientId,
      });
    } catch (error) {
      if (generation !== this.generation) return false;
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        s.discardedRev = ifRev ?? s.seenRev;
        s.seenRev = Math.max(s.seenRev, s.discardedRev);
        s.baseText = ""; s.baseOwn = false; s.dirty = false;
        s.blocked = false; s.blockedStatus = undefined; s.deferred = undefined;
        useMessageDrafts.getState().clear(key);
        useMessageDrafts.getState().removeRow(key);
        this.refresh();
        return true;
      }
      if (s.dirty && !s.blocked) this.schedule(key);
      throw error;
    }
    if (generation !== this.generation) return false;
    if (!response.deleted) {
      await this.hydrate().catch(() => {});
      if (generation !== this.generation) return false;
      if (s.dirty && !s.blocked) this.schedule(key);
      return false;
    }
    this.hydrateEpoch++;
    this.refresh();
    if (s.textSeq !== textSeq && this.text(key).trim()) {
      if (response.draft) {
        s.baseRev = Math.max(s.baseRev, response.draft.rev);
        s.seenRev = Math.max(s.seenRev, response.draft.rev);
      }
      s.baseText = "";
      s.baseOwn = false;
      s.baseMeta = emptyDraftMeta();
      s.dirty = true;
      s.blocked = false; s.blockedStatus = undefined;
      useMessageDrafts.getState().removeRow(key);
      this.schedule(key);
      return true;
    }
    if (response.draft && response.draft.rev <= s.seenRev) {
      await this.hydrate().catch(() => {});
      if (generation !== this.generation) return false;
      return false;
    }
    if (s.timer) { clearTimeout(s.timer); s.timer = undefined; }
    s.dirty = false; s.blocked = false; s.blockedStatus = undefined; s.retryCount = 0;
    s.deferred = undefined;
    if (response.draft) {
      s.baseRev = Math.max(s.baseRev, response.draft.rev);
      s.seenRev = Math.max(s.seenRev, response.draft.rev);
    }
    s.baseText = "";
    s.baseOwn = false;
    s.discardedRev = undefined;
    s.baseMeta = this.meta(key);
    useMessageDrafts.getState().clear(key);
    useMessageDrafts.getState().removeRow(key);
    return true;
  }
}

export const draftSync = new DraftSync();
