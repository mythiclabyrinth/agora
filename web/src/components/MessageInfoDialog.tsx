import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useGroups, useLatestReply, type Message } from "@agora/core";
import { copyDeepLink } from "../lib/deepLinks";
import { Icon } from "../lib/icons";

function absoluteTime(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "long",
    timeStyle: "medium",
  }).format(new Date(ts * 1000));
}

export function MessageInfoDialog({ message, groupId, onClose }: {
  message: Message;
  groupId?: string;
  onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  const id = useId();
  const titleId = `${id}-title`;
  const isRoot = message.thread_id == null;
  const hasReplies = isRoot && (message.reply_count ?? 0) > 0;
  const latest = useLatestReply(message.channel_id, message.id, hasReplies);
  const groups = useGroups().data || [];
  const channelName = groups.flatMap(group => group.channels || [])
    .find(channel => channel.id === message.channel_id)?.name || message.channel_id;
  const reactions = (message.reactions || []).reduce((sum, reaction) => sum + reaction.users.length, 0);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      requestAnimationFrame(() => previous?.isConnected && previous.focus());
    };
  }, []);

  const rows: Array<[string, string]> = [
    ["Sent", absoluteTime(message.ts)],
    ["Author", `${message.author_name || message.author_id} · ${message.author_type === "agent" ? "agent" : "person"}`],
    ["Channel", `#${channelName}`],
  ];
  if (message.meta?.edited_at) rows.push(["Edited", absoluteTime(message.meta.edited_at)]);
  if (isRoot && message.alias?.trim()) rows.push(["Thread name", message.alias.trim()]);
  if (hasReplies) rows.push(["Replies", String(message.reply_count)]);
  if (message.attachments.length) rows.push(["Attachments", String(message.attachments.length)]);
  if (reactions) rows.push(["Reactions", String(reactions)]);

  return createPortal(
    <div className="conn-overlay" onClick={event => event.stopPropagation()}
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="conn-panel ago-message-info" role="dialog" aria-modal="true"
        aria-labelledby={titleId}>
        <header className="ago-message-info-head">
          <h2 id={titleId}>Message info</h2>
          <button ref={closeButtonRef} className="btn sm" title="Close message info" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        <dl className="ago-message-info-list">
          {rows.map(([label, value]) => (
            <div className="ago-message-info-row" key={label}>
              <dt>{label}</dt><dd>{value}</dd>
            </div>
          ))}
          {hasReplies && (
            <div className="ago-message-info-row">
              <dt>Latest reply</dt>
              <dd>{latest.isLoading ? "Loading…" : latest.data
                ? `${absoluteTime(latest.data.ts)} · ${latest.data.author_name || latest.data.author_id}`
                : "Unavailable"}</dd>
            </div>
          )}
          <div className="ago-message-info-row">
            <dt>Message ID</dt>
            <dd className="ago-message-info-id">
              <code>{message.id}</code>
              {groupId && <button className="lnk" onClick={() => void copyDeepLink({
                kind: "message",
                groupId,
                channelId: message.channel_id,
                threadId: message.thread_id,
                messageId: message.id,
              }, "Message")}>Copy link</button>}
            </dd>
          </div>
        </dl>
      </section>
    </div>,
    document.body,
  );
}
