/* Search overlay (⌘K): live
   results (groups/channels/messages) with keyboard navigation, scope and
   attachment filters, "More results" paging, and the Ask-AI answer view
   with [n] citations. */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  currentPlatform, formatCombo, SHORTCUTS, esc, mdliteHtml, fmtTs, useAskAi, useGroups, useMe, useSearch, useSearchMore,
  type AskResponse, type FileFilter, type SearchMessageHit, type SearchScope,
} from "@agora/core";
import { Icon } from "../lib/icons";
import { fileUrl, humanSize } from "../lib/files";
import { toast } from "../lib/toast";
import { useJump } from "../state/jump";
import { useUiState } from "../state/ui";
import { isTopDialog, useDialogFocus } from "../hooks/useDialogFocus";
import { isDesktopShell } from "../lib/chime";
import { bindingFor, useShortcutState } from "../state/shortcuts";

type Item =
  | { kind: "command"; id: string }
  | { kind: "ask" }
  | { kind: "group"; g: { id: string; name: string; description?: string } }
  | { kind: "channel"; c: { id: string; group_id: string; name: string; topic?: string; group_name?: string } }
  | { kind: "message"; m: SearchMessageHit }
  | { kind: "more" };

/* Matched terms arrive wrapped in U+0001…U+0002 — escape first, then turn
   the markers into the highlight span. */
function snippetHTML(s: string): string {
  return esc(s)
    .replace(//g, '<span class="ago-search-hl">')
    .replace(//g, "</span>");
}

function pinSnippet(m: { alias?: string | null; text?: string }): string {
  const alias = (m.alias || "").trim();
  if (alias) return alias;
  return (m.text || "").split("\n")[0].slice(0, 140);
}

/* [n] citations become superscript links; the pre/code/link split keeps
   code blocks untouched. */
function answerHTML(answer: string, nSources: number): string {
  return mdliteHtml(answer)
    .split(/(<pre[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>|<a\b[\s\S]*?<\/a>)/)
    .map((seg, i) => i % 2 ? seg : seg.replace(/\[(\d{1,2})\]/g, (all, nRaw) => {
      const n = Number(nRaw);
      if (n < 1 || n > nSources) return all;
      return `<sup class="ago-search-cite"><a href="#" data-cite="${n}" title="Jump to source ${n}">[${n}]</a></sup>`;
    }))
    .join("");
}

function MsgRow({ m, num, sel, onClick }: {
  m: SearchMessageHit; num: number; sel: boolean; onClick: () => void;
}) {
  const crumb = `${m.group_name || ""} / #${m.channel_name || ""}`;
  const snippet = m.snippet ? snippetHTML(m.snippet) : esc(pinSnippet(m));
  return (
    <div className={`ago-search-row msg${sel ? " sel" : ""}`} title="Jump to message" onClick={onClick}>
      <div className="ago-search-msg-top">
        {num ? <span className="ago-search-srcn">{num}</span> : null}
        <span className="ago-search-author">{m.author_name || m.author_id}</span>
        <span className="ago-search-crumb">{crumb}{m.thread_id != null ? " · in thread" : ""}</span>
        <span className="ago-search-ts">{fmtTs(m.ts)}</span>
      </div>
      {snippet ? <div className="ago-search-snippet" dangerouslySetInnerHTML={{ __html: snippet }} /> : null}
      {(m.attachments || []).length > 0 && (
        <div className="ago-atts">
          {(m.attachments || []).map(f => (
            <a key={f.id} className="ago-att-file" href={fileUrl(f.id)} download={f.filename}
              target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
              title={`Download ${f.filename}`}>
              <span className="ago-file-icon">
                <Icon name={(f.mime || "").startsWith("image/") ? "image" : "file-text"} />
              </span>
              <span className="ago-file-meta">
                <span className="fname">{f.filename}</span>
                <span className="fsize">{humanSize(f.size)}</span>
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

const FILE_LABELS: Record<string, string> = {
  any: "attachments", image: "images", pdf: "PDFs", doc: "documents",
  video: "video", audio: "audio",
};

export function SearchPane() {
  const ui = useUiState();
  const me = useMe().data;
  const groups = useGroups().data || [];
  useShortcutState(s => s.bindings);
  const [query, setQuery] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [scopeStr, setScopeStr] = useState("");
  const [file, setFile] = useState<FileFilter>("");
  const [sel, setSel] = useState(0);
  const [view, setView] = useState<"results" | "ask">("results");
  const [answer, setAnswer] = useState<AskResponse | "loading" | null>(null);
  const [extra, setExtra] = useState<SearchMessageHit[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const askAi = useAskAi();
  const more = useSearchMore();
  const panelRef = useDialogFocus(ui.searchOpen, () => {
    if (view === "ask") { setView("results"); setAnswer(null); setSel(0); inputRef.current?.focus(); }
    else ui.setSearchOpen(false);
  });

  const scope: SearchScope | undefined = scopeStr.startsWith("g:")
    ? { groupId: scopeStr.slice(2) }
    : scopeStr.startsWith("c:") ? { channelId: scopeStr.slice(2) } : undefined;
  const res = useSearch(debouncedQ, scope, file);

  // 250ms input debounce.
  useEffect(() => {
    const t = setTimeout(() => { setDebouncedQ(query.trim()); setSel(0); setExtra([]); }, 250);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (ui.searchOpen) {
      setView("results");
      setAnswer(null);
      setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 0);
    }
  }, [ui.searchOpen]);

  const requestJump = useJump(s => s.request);
  const jumpTo = (m: SearchMessageHit) => {
    ui.setSearchOpen(false);
    ui.selectChannel(m.group_id, m.channel_id);
    if (m.thread_id != null) {
      ui.openThread(m.thread_id, "replace");
      requestJump({ mid: m.id, container: "thread" });
    } else {
      requestJump({ mid: m.id, container: "log" });
    }
  };

  const runAsk = () => {
    if (!debouncedQ) return;
    setView("ask");
    setAnswer("loading");
    setSel(0);
    askAi.mutate({ q: debouncedQ, scope }, {
      onSuccess: (data) => setAnswer(data),
      onError: (e) => {
        toast("Ask AI failed: " + (e as Error).message, { variant: "warn" });
        setView("results");
        setAnswer(null);
      },
    });
  };

  const msgs = useMemo(
    () => [...(res.data?.messages?.items || []), ...extra],
    [res.data, extra],
  );
  const commands = view === "results" && !scopeStr && !file && query.trim() === debouncedQ
    ? SHORTCUTS.filter(s => (s.id === "help.sheet" || s.id.startsWith("nav.") || ["settings", "ui.sidebar", "link.copy"].includes(s.id)) && (!s.feature || !!me?.[s.feature]) && (!s.desktopOnly || isDesktopShell()) &&
      (debouncedQ ? `${s.label} ${s.id}`.toLowerCase().includes(debouncedQ.toLowerCase()) :
        ["help.sheet", "nav.inbox", "nav.unreads", "nav.threads", "settings"].includes(s.id)))
    : [];

  // Build the item list in display order.
  const items: Item[] = useMemo(() => {
    const list: Item[] = [];
    if (view === "ask") {
      if (answer && answer !== "loading" && answer.answer) {
        for (const m of answer.sources || []) list.push({ kind: "message", m });
      }
      return list;
    }
    if (!debouncedQ && !file) {
      for (const s of commands) list.push({ kind: "command", id: s.id });
      return list;
    }
    if (me?.search_ai && debouncedQ) list.push({ kind: "ask" });
    for (const g of res.data?.groups || []) list.push({ kind: "group", g });
    for (const c of res.data?.channels || []) list.push({ kind: "channel", c });
    for (const s of commands) list.push({ kind: "command", id: s.id });
    for (const m of msgs) list.push({ kind: "message", m });
    if (res.data?.messages?.has_more) list.push({ kind: "more" });
    return list;
  }, [view, answer, me, debouncedQ, res.data, msgs, commands, scopeStr, file]);

  const activate = (i: number) => {
    const it = items[i];
    if (!it) return;
    setSel(i);
    if (it.kind === "command") {
      ui.setSearchOpen(false);
      setTimeout(() => (window as Window & { __agoraShortcut?: (id: string) => void }).__agoraShortcut?.(it.id), 0);
      return;
    }
    if (it.kind === "ask") { runAsk(); return; }
    if (it.kind === "more") {
      more.mutate({ q: debouncedQ, offset: msgs.length, scope, file }, {
        onSuccess: (page) => setExtra(x => [...x, ...(page?.items || [])]),
        onError: (e) => toast("Couldn't load more results: " + (e as Error).message, { variant: "warn" }),
      });
      return;
    }
    if (it.kind === "group") {
      ui.setSearchOpen(false);
      ui.openGroupPage(it.g.id);
      return;
    }
    if (it.kind === "channel") {
      ui.setSearchOpen(false);
      ui.selectChannel(it.c.group_id, it.c.id);
      return;
    }
    jumpTo(it.m);
  };

  // The shortcut hook owns Mod+K; this listener handles search-result keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (!useUiState.getState().searchOpen || !isTopDialog(panelRef.current)) return;
      if (e.isComposing) return;
      if ((e.target as HTMLElement)?.id === "ago-search-scope") return;
      if (e.key === "ArrowDown") { e.preventDefault(); setSel(s => items.length ? (s + 1) % items.length : 0); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSel(s => items.length ? (s - 1 + items.length) % items.length : 0); return; }
      if (e.key === "Enter") { e.preventDefault(); activate(sel); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  if (!ui.searchOpen) return null;

  const scopeName = (() => {
    for (const g of groups) {
      if (scopeStr === `g:${g.id}`) return g.name;
      for (const c of g.channels || []) if (scopeStr === `c:${c.id}`) return `#${c.name}`;
    }
    return "";
  })();

  let itemIdx = -1;
  const nextIdx = () => ++itemIdx;
  const renderCommands = () => commands.length > 0 && <>
    <div className="ago-search-label">Commands</div>
    {commands.map(s => {
      const i = nextIdx();
      return <div key={s.id} className={`ago-search-row${sel === i ? " sel" : ""}`}
        role="button" tabIndex={-1} onClick={() => activate(i)}>
        <span className="ago-search-ico"><Icon name="keyboard" /></span>
        <span className="ago-search-name">{s.label}</span>
        {bindingFor(s.id, currentPlatform()) && <kbd>{formatCombo(bindingFor(s.id, currentPlatform()), currentPlatform())}</kbd>}
      </div>;
    })}
  </>;

  return (
    <div className="ago-search-overlay" id="ago-search-overlay"
      onClick={e => { if (e.target === e.currentTarget) ui.setSearchOpen(false); }}>
      <div className="ago-search-panel" ref={panelRef} role="dialog" aria-modal="true" aria-label="Search conversations" tabIndex={-1}>
        <div className="ago-search-bar">
          <Icon name="search" />
          <input id="ago-search-input" ref={inputRef} placeholder="Search messages, channels, groups…"
            autoComplete="off" autoCapitalize="off" spellCheck={false}
            value={query} onChange={e => setQuery(e.target.value)} />
          <select id="ago-search-scope" className="ago-search-scope" title="Search scope"
            value={scopeStr} onChange={e => { setScopeStr(e.target.value); setExtra([]); }}>
            <option value="">Everywhere</option>
            {groups.map(g => (
              <optgroup key={g.id} label={g.name}>
                <option value={`g:${g.id}`}>All of {g.name}</option>
                {(g.channels || []).map(c => (
                  <option key={c.id} value={`c:${c.id}`}># {c.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <select id="ago-search-files" className="ago-search-scope" title="Filter by attachment"
            value={file} onChange={e => { setFile(e.target.value as FileFilter); setExtra([]); }}>
            <option value="">Any content</option>
            <option value="any">📎 Has files</option>
            <option value="image">🖼 Images</option>
            <option value="pdf">📄 PDFs</option>
            <option value="doc">📝 Documents</option>
            <option value="video">🎬 Video</option>
            <option value="audio">🎵 Audio</option>
          </select>
          <button className="ago-x" title="Close (Esc)" onClick={() => ui.setSearchOpen(false)}>
            <Icon name="x" />
          </button>
        </div>
        <div className="ago-search-body" id="ago-search-body"
          onClick={e => {
            const cite = (e.target as HTMLElement).closest?.("[data-cite]");
            if (cite && answer && answer !== "loading") {
              e.preventDefault();
              const src = (answer.sources || [])[Number(cite.getAttribute("data-cite")) - 1];
              if (src) jumpTo(src);
            }
          }}>
          {view === "ask" ? (
            <>
              <div className="ago-search-askhead">
                <button className="btn sm" title="Back to results (Esc)"
                  onClick={() => { setView("results"); setAnswer(null); setSel(0); }}>
                  <Icon name="chevron-left" /> Results
                </button>
                <span className="ago-search-askq"><Icon name="sparkles" /> {debouncedQ}</span>
              </div>
              {!answer || answer === "loading" ? (
                <div className="ago-search-thinking"><Icon name="loader" cls="spin" /> Thinking…</div>
              ) : !answer.answer ? (
                <div className="ago-search-hint">{answer.detail || "No answer."}</div>
              ) : (
                <>
                  <div className="ago-search-answer"
                    dangerouslySetInnerHTML={{ __html: answerHTML(answer.answer, (answer.sources || []).length) }} />
                  {(answer.sources || []).length > 0 && <div className="ago-search-label">Sources</div>}
                  {(answer.sources || []).map((m, k) => {
                    const i = nextIdx();
                    return <MsgRow key={m.id} m={m} num={k + 1} sel={sel === i} onClick={() => activate(i)} />;
                  })}
                </>
              )}
            </>
          ) : !debouncedQ && !file ? (<>
            {renderCommands()}
            <div className="ago-search-hint">
              Search messages, channels, and groups{me?.search_ai ? " — or ask the AI a question" : ""}.
            </div>
          </>
          ) : (
            <>
              {me?.search_ai && debouncedQ && (() => {
                const i = nextIdx();
                return (
                  <div key="ask" className={`ago-search-row ask${sel === i ? " sel" : ""}`}
                    title="Answer this from your message history" onClick={() => activate(i)}>
                    <span className="ago-search-spark"><Icon name="sparkles" /></span>
                    <span className="ago-search-ask-label">Ask Agora AI: <b>“{debouncedQ}”</b></span>
                  </div>
                );
              })()}
              {(res.data?.groups || []).length > 0 && <div className="ago-search-label">Groups</div>}
              {(res.data?.groups || []).map(g => {
                const i = nextIdx();
                return (
                  <div key={g.id} className={`ago-search-row${sel === i ? " sel" : ""}`}
                    title={`Open ${g.name}`} onClick={() => activate(i)}>
                    <span className="ago-search-ico"><Icon name="layout-grid" /></span>
                    <span className="ago-search-name">{g.name}</span>
                    {g.description ? <span className="ago-search-sub">{g.description}</span> : null}
                  </div>
                );
              })}
              {(res.data?.channels || []).length > 0 && <div className="ago-search-label">Channels</div>}
              {(res.data?.channels || []).map(c => {
                const i = nextIdx();
                return (
                  <div key={c.id} className={`ago-search-row${sel === i ? " sel" : ""}`}
                    title={`Open #${c.name}`} onClick={() => activate(i)}>
                    <span className="ago-search-ico hash">#</span>
                    <span className="ago-search-name">{c.name}</span>
                    <span className="ago-search-crumb">{c.group_name || ""}</span>
                    {c.topic ? <span className="ago-search-sub">{c.topic}</span> : null}
                  </div>
                );
              })}
              {renderCommands()}
              {msgs.length > 0 && <div className="ago-search-label">Messages</div>}
              {msgs.map(m => {
                const i = nextIdx();
                return <MsgRow key={m.id} m={m} num={0} sel={sel === i} onClick={() => activate(i)} />;
              })}
              {res.data?.messages?.has_more && (() => {
                const i = nextIdx();
                return (
                  <div key="more" className={`ago-search-row more${sel === i ? " sel" : ""}`} onClick={() => activate(i)}>
                    {more.isPending ? <><Icon name="loader" cls="spin" /> Loading…</> : "More results"}
                  </div>
                );
              })()}
              {res.isError ? (
                <div className="ago-search-hint">Search failed: {(res.error as Error).message}</div>
              ) : res.isLoading && (debouncedQ || file) ? (
                <div className="ago-search-hint">Searching…</div>
              ) : res.data && !(res.data.groups || []).length && !(res.data.channels || []).length && !msgs.length ? (
                <div className="ago-search-hint">
                  {debouncedQ
                    ? `No results for “${debouncedQ}”${scopeName ? ` in ${scopeName}` : ""}`
                    : `No messages with ${FILE_LABELS[file] || "attachments"} found${scopeName ? ` in ${scopeName}` : ""}`}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
