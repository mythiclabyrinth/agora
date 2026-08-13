/* Composer (.chat-input): textarea with autogrow, Enter-to-send, mention
   autocomplete (@…), the "talk to" agent addressing picker, file chips
   (paste/drag/pick, 5-file cap), and the thread-ask toggle. */

import { useEffect, useRef, useState } from "react";
import {
  DroppedFileError, dropMaterializationLimit,
  droppedTooLargeMessage, uploadMaxBytes,
  draftAttachmentPreviewUrl, materializeDroppedFile, MAX_MESSAGE_CHARS,
  useAgents, useAttachmentDrafts, useMe, useSendMessage,
  type ChannelAgent, type DraftAttachment, type OutgoingFile,
} from "@agora/core";
import { create } from "zustand";
import { Icon } from "../lib/icons";
import { autoGrow } from "../lib/autoGrow";
import { BROWSER_IMAGE, humanSize, withToken } from "../lib/files";
import { slugify } from "../lib/mentions";
import { toast } from "../lib/toast";
import { MicButton } from "./VoiceControls";
import { ImageLightbox } from "./ImageLightbox";
import { TemplateControls } from "./TemplateControls";

const MAX_FILES = 5;
const ATTACHMENT_UPLOAD_TIMEOUT_MS = 120_000;
const NO_ATTACHMENTS: DraftAttachment[] = [];

export interface MentionCandidate {
  type: "agent" | "user";
  id: string;
  name: string;
  slug: string;
  avatar?: string;
}

/* Per-target drafts: keyed "c:<channelId>" or "t:<rootId>". */
interface DraftState {
  drafts: Record<string, string>;
  set: (key: string, text: string) => void;
}
export const useDrafts = create<DraftState>((set) => ({
  drafts: {},
  set: (key, text) => set(s => ({ drafts: { ...s.drafts, [key]: text } })),
}));

/* "Talk to" selection per composer target (channel / thread), ephemeral. */
interface AddrState {
  addr: Record<string, string[]>;
  toggle: (key: string, agentId: string) => void;
  clear: (key: string) => void;
}
const NO_ADDR: string[] = [];

export const useAddressing = create<AddrState>((set) => ({
  addr: {},
  toggle: (key, agentId) => set(s => {
    const cur = s.addr[key] || [];
    const next = cur.includes(agentId) ? cur.filter(id => id !== agentId) : [...cur, agentId];
    const addr = { ...s.addr };
    if (next.length) addr[key] = next; else delete addr[key];
    return { addr };
  }),
  clear: (key) => set(s => {
    const addr = { ...s.addr };
    delete addr[key];
    return { addr };
  }),
}));

/* Agent avatar for composer rows (addressing chips, "Talk to" picker, mention
   popup). The lists these rows iterate may be the bare channel-agents payload
   ({id, name} — no avatar), so resolve the picture from the full /api/agents
   roster by id, exactly like vanilla's agoAgentAvatarHTML and MessageItem. */
function AgentAv({ a, cls }: { a: { id: string; avatar?: string }; cls: string }) {
  const roster = useAgents().data || [];
  const [failed, setFailed] = useState(false);
  const av = a.avatar || roster.find(r => r.id === a.id)?.avatar;
  if (av && !failed) {
    return (
      <span className={`ago-av ${cls} has-avatar`}>
        <img src={withToken(av)} alt="" onError={() => setFailed(true)} />
      </span>
    );
  }
  return <span className={`ago-av ${cls}`}><Icon name="bot" /></span>;
}

export function Composer({ channelId, channelName, groupId, threadId, agents = [], candidates = [], voiceOK, replyInThread, onSetReplyInThread }: {
  channelId: string;
  channelName: string;
  groupId: string;
  threadId: number | null;
  /** Live member agents of the channel (addressing picker + mention list). */
  agents?: ChannelAgent[];
  /** Everything @-mentionable (agents + group members). */
  candidates?: MentionCandidate[];
  /** Server has STT/TTS (me.voice): show the mic. */
  voiceOK?: boolean;
  replyInThread?: boolean;
  onSetReplyInThread?: (value: boolean) => void;
}) {
  const send = useSendMessage(channelId);
  const me = useMe().data;
  const draftKey = threadId != null ? `t:${threadId}` : `c:${channelId}`;
  const text = useDrafts(s => s.drafts[draftKey] ?? "");
  const setText = useDrafts(s => s.set);
  const attachments = useAttachmentDrafts(s => s.byDraft[draftKey] ?? NO_ATTACHMENTS);
  const [mention, setMention] = useState<{ items: MentionCandidate[]; active: number; start: number } | null>(null);
  const [addrOpen, setAddrOpen] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const addrSel = useAddressing(s => s.addr[draftKey] ?? NO_ADDR);
  const addrToggle = useAddressing(s => s.toggle);
  const addrClear = useAddressing(s => s.clear);
  const taRef = useRef<HTMLTextAreaElement>(null);
  /* Whether the caret in this draft is the user's. One textarea is reused
     across channels/threads, so a stale selection from the previous
     conversation must not decide where a template lands. */
  const hasCaret = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { hasCaret.current = false; }, [draftKey]);
  /* Controlled draft changes commit after event handlers run. Resize from the
     committed value so clears after sends (including async attachment sends)
     and conversation switches can shrink a previously tall textarea. */
  useEffect(() => { autoGrow(taRef.current); }, [text]);
  /* Routing can mount a composer while its pane is display:none. In that
     state scrollHeight is zero, so resize again when responsive navigation or
     initial route resolution gives the textarea a real layout box. */
  useEffect(() => {
    const input = taRef.current;
    if (!input || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => autoGrow(input));
    observer.observe(input);
    return () => observer.disconnect();
  }, []);

  const inThread = threadId != null;
  const readyAttachments = attachments.filter(
    (entry): entry is DraftAttachment & { status: "ready"; file: File } =>
      entry.status === "ready" && !!entry.file,
  );
  const preparingAttachments = attachments.filter(entry => entry.status === "preparing");
  const sendingAttachments = attachments.filter(entry => entry.status === "sending");
  const maxBytesFor = (file: File) => uploadMaxBytes(file.type, me?.max_file_mb, me?.max_video_mb);
  const dropMaxBytes = dropMaterializationLimit(Math.max(me?.max_file_mb ?? 0, me?.max_video_mb ?? 0));
  const dropMaxBytesFor = (file: File) => Math.min(dropMaxBytes, maxBytesFor(file) ?? Infinity);
  const inputId = inThread ? "ago-thread-msg" : "ago-msg";
  const selectedAgents = addrSel
    .map(id => agents.find(a => a.id === id))
    .filter(Boolean) as ChannelAgent[];
  const previewEntry = attachments.find(entry => entry.id === previewId) ?? null;
  const previewUrl = previewEntry ? draftAttachmentPreviewUrl(previewEntry) : null;

  // Click-away closes the addressing popup (button/popup exempt).
  useEffect(() => {
    if (!addrOpen) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest?.(".ago-addr-pop") || t.closest?.(".ago-addr-btn")) return;
      setAddrOpen(false);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [addrOpen]);

  const addFiles = (list: FileList | File[]) => {
    const incoming = Array.from(list);
    const nonEmpty = incoming.filter((file) => file.size > 0);
    const allowed = nonEmpty.filter((file) => {
      const maxBytes = maxBytesFor(file);
      return maxBytes === undefined || file.size <= maxBytes;
    });
    if (nonEmpty.length < incoming.length) {
      toast("Empty files cannot be uploaded", { variant: "warn" });
    }
    if (allowed.length < nonEmpty.length) {
      const messages = new Set(nonEmpty.filter(file => !allowed.includes(file)).map(file =>
        droppedTooLargeMessage(file.type, me?.max_file_mb, me?.max_video_mb)));
      toast(messages.size === 1 ? [...messages][0] : "Some files exceed their upload limit", { variant: "warn" });
    }
    const result = useAttachmentDrafts.getState().stage(
      draftKey,
      allowed,
      "ready",
      MAX_FILES,
    );
    if (result.rejectedForCap) {
      toast(`Up to ${MAX_FILES} files per message`, { variant: "warn" });
    }
  };

  const prepareDroppedFile = async (
    entry: DraftAttachment,
    source: File,
  ) => {
    try {
      const file = await materializeDroppedFile(source, { maxBytes: dropMaxBytesFor(source) });
      useAttachmentDrafts.getState().complete(draftKey, entry.id, file);
    } catch (error) {
      const message = error instanceof DroppedFileError && error.code === "too_large"
        ? droppedTooLargeMessage(source.type, me?.max_file_mb, me?.max_video_mb)
        : error instanceof DroppedFileError && error.code === "empty"
          ? "Empty files cannot be uploaded"
          : "Could not read the dropped file";
      // Cancellation removes the entry. A late failure then cannot surface in
      // whichever channel the user has navigated to.
      useAttachmentDrafts.getState().fail(draftKey, entry.id, message);
    }
  };

  const addDroppedFiles = (list: FileList) => {
    const dropped = Array.from(list);
    // A promised file may report size 0 before its provider resolves, so only
    // reject metadata that already proves the drop cannot be materialized.
    const allowed = dropped.filter((file) => file.size <= dropMaxBytesFor(file));
    if (allowed.length < dropped.length) {
      const rejected = dropped.filter(file => file.size > dropMaxBytesFor(file));
      const messages = new Set(rejected.map(file =>
        droppedTooLargeMessage(file.type, me?.max_file_mb, me?.max_video_mb)));
      toast(messages.size === 1 ? [...messages][0] : "Large files must be attached with the paperclip",
        { variant: "warn" });
    }
    const result = useAttachmentDrafts.getState().stage(
      draftKey,
      allowed,
      "preparing",
      MAX_FILES,
    );
    if (result.rejectedForCap) {
      toast(`Up to ${MAX_FILES} files per message`, { variant: "warn" });
    }
    // Each call enters materializeDroppedFile before its first await, while the
    // macOS promised-file provider is still alive for this drop event.
    result.accepted.forEach((entry, index) => {
      void prepareDroppedFile(entry, allowed[index]);
    });
  };

  /* Mention autocomplete: a live "@token" ending at the caret. */
  const updateMention = (value: string, caret: number) => {
    const upToCaret = value.slice(0, caret);
    const at = upToCaret.lastIndexOf("@");
    const live = at >= 0 && (at === 0 || /\s/.test(upToCaret[at - 1])) && !/\s/.test(upToCaret.slice(at + 1));
    if (!live) { setMention(null); return; }
    const q = upToCaret.slice(at + 1).toLowerCase();
    const items = candidates.filter(c =>
      c.name.toLowerCase().includes(q) || c.slug.toLowerCase().includes(q));
    if (!items.length) { setMention(null); return; }
    setMention(m => ({
      items,
      active: Math.min(m?.active || 0, items.length - 1),
      start: at,
    }));
  };

  const pickMention = (i: number) => {
    const c = mention?.items[i];
    const input = taRef.current;
    if (!c || !input || !mention) { setMention(null); return; }
    const caret = input.selectionStart ?? text.length;
    const next = text.slice(0, mention.start) + "@" + c.slug + " " + text.slice(caret);
    setText(draftKey, next);
    const pos = mention.start + c.slug.length + 2;
    setMention(null);
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(pos, pos);
    });
  };

  const doSend = () => {
    if (preparingAttachments.length) {
      toast(
        preparingAttachments.length === 1
          ? "Please wait while the dropped file is prepared"
          : "Please wait while the dropped files are prepared",
        { variant: "warn" },
      );
      return;
    }
    const t = text.trim();
    if (!t && !readyAttachments.length) return;
    if (sendingAttachments.length) {
      toast("Please wait while the attachment is sent", { variant: "warn" });
      return;
    }
    // "Talk to" prefix: the chosen agents' mentions route the message.
    const addr = selectedAgents.map(a => "@" + slugify(a.name)).join(", ");
    const outText = addr ? (t ? `${addr}, ${t}` : addr) : t;
    const outgoing: OutgoingFile[] = readyAttachments.map(entry => ({
      part: entry.file,
      name: entry.name,
    }));
    const sentIds = readyAttachments.map(entry => entry.id);
    const sentText = text;
    const controller = sentIds.length ? new AbortController() : null;
    if (controller && !useAttachmentDrafts.getState().beginSend(
      draftKey,
      sentIds,
      () => controller.abort(),
    )) {
      toast("Attachments changed — please try Send again", { variant: "warn" });
      return;
    }
    const uploadTimer = controller
      ? setTimeout(() => controller.abort(), ATTACHMENT_UPLOAD_TIMEOUT_MS)
      : undefined;
    void send.mutateAsync({
      text: outText,
      threadId,
      files: outgoing.length ? outgoing : undefined,
      replyInThread,
      signal: controller?.signal,
    }).then(() => {
      if (!sentIds.length) return;
      useAttachmentDrafts.getState().sendSucceeded(draftKey, sentIds);
      if ((useDrafts.getState().drafts[draftKey] ?? "") === sentText) {
        setText(draftKey, "");
      }
      if (replyInThread && onSetReplyInThread) onSetReplyInThread(false);
    }).catch((error) => {
      if (sentIds.length) useAttachmentDrafts.getState().sendFailed(draftKey, sentIds);
      const aborted = controller?.signal.aborted;
      toast(
        aborted ? "Attachment upload cancelled or timed out" : "Send failed: " + (error as Error).message,
        { variant: "warn" },
      );
    }).finally(() => {
      if (uploadTimer !== undefined) clearTimeout(uploadTimer);
    });
    // Preserve attachment-bearing drafts until the upload succeeds. Plain text
    // keeps the existing fast optimistic composer behavior.
    if (!sentIds.length) {
      setText(draftKey, "");
      if (replyInThread && onSetReplyInThread) onSetReplyInThread(false);
    }
    taRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention) {
      const n = mention.items.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setMention({ ...mention, active: (mention.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickMention(mention.active);
        return;
      }
      if (e.key === "Escape") { setMention(null); return; }
    }
    if (e.key === "Escape" && addrOpen) { setAddrOpen(false); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }
  };

  /* Insert a template at the caret rather than replacing the draft — the
     picker steals focus, so the textarea's last selection is the insert
     point. Deliberately does not run updateMention: an "@name" inside a
     template should not open the mention popup. */
  const insertTemplate = (template: string) => {
    const input = taRef.current;
    const start = hasCaret.current ? (input?.selectionStart ?? text.length) : text.length;
    const end = hasCaret.current ? (input?.selectionEnd ?? start) : start;
    const next = text.slice(0, start) + template + text.slice(end);
    /* Count code points, like the server's chars().count(). */
    if ([...next].length > MAX_MESSAGE_CHARS) {
      toast(`Template would exceed the ${MAX_MESSAGE_CHARS.toLocaleString()}-character message limit`,
        { variant: "warn" });
      return;
    }
    const caret = start + template.length;
    setText(draftKey, next);
    /* The value lands on the next render; focus/caret/autogrow after it. */
    requestAnimationFrame(() => {
      if (!input) return;
      input.focus();
      input.setSelectionRange(caret, caret);
      hasCaret.current = true;
      autoGrow(input);
    });
  };

  return (
    <>
      {selectedAgents.length > 0 && (
        <div className="ago-addr-bar">
          <span className="ago-addr-label">To</span>
          {selectedAgents.map(a => (
            <span key={a.id} className="ago-addr-chip" title={`@${slugify(a.name)}`}>
              <AgentAv a={a} cls="xs" />
              <span className="aname">{a.name}</span>
              <button className="ago-x" title={`Stop addressing ${a.name}`}
                onClick={() => addrToggle(draftKey, a.id)}>
                <Icon name="x" />
              </button>
            </span>
          ))}
          <button className="ago-addr-clear" title="Address everyone in the channel again"
            onClick={() => addrClear(draftKey)}>Clear</button>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="ago-pending">
          {attachments.map(entry => {
            const imageType = (entry.type || "").startsWith("image/");
            const previewable = BROWSER_IMAGE.test(entry.type || "");
            const url = previewable ? draftAttachmentPreviewUrl(entry) : null;
            return (
            <span key={entry.id} className={`ago-pending-chip ${url ? "image" : "file"}`} title={entry.name}>
              {url ? (
                <button
                  type="button"
                  className="ago-pending-thumb"
                  aria-label={`Preview ${entry.name}`}
                  onClick={() => setPreviewId(entry.id)}
                >
                  <img src={url} alt="" />
                </button>
              ) : (
                <span className={`ago-file-icon ${entry.status === "preparing" ? "preparing" : ""}`}>
                  <Icon name={imageType ? "image" : "file-text"} />
                </span>
              )}
              <span className="ago-file-meta">
                <span className="fname">
                {entry.status === "preparing"
                  ? `Preparing ${entry.name}…`
                  : entry.status === "sending"
                    ? `Sending ${entry.name}…`
                  : entry.status === "failed"
                    ? entry.error || `Could not read ${entry.name}`
                    : entry.name}
                </span>
                {entry.status === "ready" && <span className="fsize">{humanSize(entry.size)}</span>}
              </span>
              <button className="ago-x"
                title={entry.status === "sending"
                  ? "Cancel upload"
                  : entry.status === "preparing" ? "Cancel" : "Remove"}
                onClick={() => entry.status === "sending"
                  ? useAttachmentDrafts.getState().cancelSend(draftKey, entry.id)
                  : useAttachmentDrafts.getState().remove(draftKey, entry.id)}>
                <Icon name="x" />
              </button>
            </span>
          )})}
        </div>
      )}
      {previewEntry && previewUrl && (
        <ImageLightbox url={previewUrl} filename={previewEntry.name}
          onClose={() => setPreviewId(null)} />
      )}
      <div className="chat-input"
        onDragOver={e => e.preventDefault()}
        onDrop={e => {
          e.preventDefault();
          if (e.dataTransfer?.files?.length) addDroppedFiles(e.dataTransfer.files);
        }}>
        {agents.length > 0 && (
          <button className={`btn ago-addr-btn ${addrSel.length ? "active" : ""}`}
            title="Choose which agents you're talking to"
            onClick={() => setAddrOpen(!addrOpen)}>
            <Icon name="bot" />{addrSel.length ? <span className="ago-addr-count">{addrSel.length}</span> : null}
          </button>
        )}
        <textarea id={inputId} ref={taRef} rows={1}
          placeholder={inThread ? "Reply in thread…" : `Message #${channelName}`}
          title="@mention an agent to address it directly"
          value={text}
          onChange={e => {
            hasCaret.current = true;
            setText(draftKey, e.target.value);
            autoGrow(e.target);
            updateMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyDown={onKeyDown}
          onSelect={() => { hasCaret.current = true; }}
          onBlur={() => setTimeout(() => setMention(null), 150)}
          onPaste={e => {
            const items = Array.from(e.clipboardData?.files || []);
            if (items.length) { e.preventDefault(); addFiles(items); }
          }} />
        {mention && (
          <div className="ago-mention-pop" id="ago-mention-pop">
            {mention.items.map((c, i) => (
              <div key={`${c.type}-${c.id}`}
                className={`ago-mention-opt ${i === mention.active ? "active" : ""}`}
                onMouseDown={e => { e.preventDefault(); pickMention(i); }}>
                {c.type === "agent"
                  ? <AgentAv a={c} cls="sm" />
                  : <span className="ago-av sm"><Icon name="user" /></span>}
                <span className="mname">{c.name}</span>
                <span className="mmeta">{c.type}</span>
              </div>
            ))}
          </div>
        )}
        <input ref={fileRef} type="file" multiple style={{ display: "none" }}
          onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
        <button className="btn ago-attach-btn" title="Attach files"
          onClick={() => fileRef.current?.click()}>
          <Icon name="paperclip" />
        </button>
        <TemplateControls groupId={groupId} draft={text} onChoose={insertTemplate} />
        {voiceOK && <MicButton channelId={channelId} threadId={threadId} />}
        {!inThread && onSetReplyInThread && (
          <button className={`btn ago-thread-ask ${replyInThread ? "active" : ""}`} id="ago-thread-ask"
            title="Agents answer this message in a thread under it"
            onClick={() => onSetReplyInThread(!replyInThread)}>
            <Icon name="messages-square" />
          </button>
        )}
        <button className="btn primary"
          disabled={preparingAttachments.length > 0 || sendingAttachments.length > 0}
          onClick={doSend}>Send</button>
        {addrOpen && (
          <div className="ago-addr-pop" id="ago-addr-pop">
            <div className="ago-addr-pop-head">
              <span>Talk to</span>
              {addrSel.length > 0 && (
                <button className="ago-addr-clear" onClick={() => addrClear(draftKey)}>Clear</button>
              )}
            </div>
            {agents.length ? agents.map(a => {
              const on = addrSel.includes(a.id);
              return (
                <div key={a.id} className={`ago-addr-opt ${on ? "selected" : ""}`} role="option"
                  aria-selected={on} onClick={() => addrToggle(draftKey, a.id)}>
                  <AgentAv a={a} cls="sm" />
                  <span className="mname">{a.name}</span>
                  <span className="ago-addr-check">{on ? <Icon name="check" /> : null}</span>
                </div>
              );
            }) : <div className="ago-addr-empty">No agents in this channel yet.</div>}
          </div>
        )}
      </div>
    </>
  );
}
