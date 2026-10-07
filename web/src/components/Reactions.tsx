/* Reaction chips + the trailing add button. The picker itself lives in
   EmojiPicker. */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { hasMine, useAgents, useMe, useToggleReaction, useUsers, type Message, type Reaction } from "@agora/core";
import { Icon } from "../lib/icons";
import { withToken } from "../lib/files";
import { watchAnchoredOverlay } from "../lib/anchoredOverlay";

export function Reactions({ message, onPick }: {
  message: Message;
  onPick: (anchor: HTMLElement) => void;
}) {
  const me = useMe().data;
  const toggle = useToggleReaction();
  const [open, setOpen] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const hold = useRef<number | null>(null);
  const held = useRef(false);
  const closeTimer = useRef<number | null>(null);
  const clearHold = () => {
    if (hold.current !== null) window.clearTimeout(hold.current);
    hold.current = null;
  };
  const cancelClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const show = (emoji: string, element: HTMLElement) => {
    cancelClose();
    setAnchor(element);
    setOpen(emoji);
  };
  const closeSoon = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(null), 80);
  };
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && open) { event.preventDefault(); setOpen(null); } };
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (!root.current?.contains(target) && !target.closest?.(".ago-react-pop")) setOpen(null);
    };
    window.addEventListener("keydown", close);
    document.addEventListener("pointerdown", closeOutside);
    return () => {
      window.removeEventListener("keydown", close);
      document.removeEventListener("pointerdown", closeOutside);
      clearHold();
      cancelClose();
    };
  }, [open]);
  const list = message.reactions || [];
  if (!list.length) return null;
  return (
    <div className="ago-reacts" ref={root}>
      {list.map(r => {
        const users = r.users || [];
        const mine = !!me && hasMine(r, me.username);
        const names = r.reactors?.map(reactor => reactor.name) ?? users;
        const reactors = `${names.join(", ")} reacted with ${r.emoji}`;
        return (
          <span key={r.emoji} className="ago-react-wrap">
            <button className={`ago-react ${mine ? "mine" : ""}`}
              aria-label={reactors} aria-describedby={open === r.emoji ? `reactors-${message.id}-${r.emoji}` : undefined}
              onMouseEnter={event => show(r.emoji, event.currentTarget)}
              onMouseLeave={closeSoon}
              onFocus={event => show(r.emoji, event.currentTarget)}
              onBlur={closeSoon}
              onPointerDown={(event) => {
                held.current = false;
                if (event.pointerType === "touch") {
                  const target = event.currentTarget;
                  hold.current = window.setTimeout(() => {
                    held.current = true;
                    show(r.emoji, target);
                  }, 450);
                }
              }}
              onPointerUp={clearHold}
              onPointerCancel={clearHold}
              onPointerLeave={clearHold}
              onLostPointerCapture={clearHold}
              onClick={() => { if (held.current) { held.current = false; return; } toggle.mutate({ message, emoji: r.emoji, on: !mine }); }}>
              {r.emoji}<span className="rc">{users.length}</span>
            </button>
            {open === r.emoji && anchor ? (
              <ReactorPopover
                id={`reactors-${message.id}-${r.emoji}`}
                reaction={r}
                anchor={anchor}
                onMouseEnter={cancelClose}
                onMouseLeave={closeSoon}
              />
            ) : null}
          </span>
        );
      })}
      <button className="ago-react ago-react-add" title="Add reaction"
        onClick={e => onPick(e.currentTarget)}>
        <Icon name="smile" />
      </button>
    </div>
  );
}

function ReactorPopover({ id, reaction, anchor, onMouseEnter, onMouseLeave }: {
  id: string;
  reaction: Reaction;
  anchor: HTMLElement;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const users = useUsers().data || [];
  const agents = useAgents(60_000).data || [];
  const popRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!popRef.current) return;
    return watchAnchoredOverlay(anchor, popRef.current, "center");
  }, [anchor, reaction.reactors?.length, reaction.users?.length]);
  const reactors = reaction.reactors ?? (reaction.users || []).map(name => ({ type: "user" as const, id: name, name }));
  return createPortal(<div id={id} ref={popRef} className="ago-react-pop" role="tooltip"
    onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
    <div className="ago-react-pop-body">
      <strong>{reaction.emoji} reactions</strong>
      {reactors.map(r => {
        const agent = r.type === "agent" ? agents.find(a => a.id === r.id) : undefined;
        const user = r.type === "user" ? users.find(u => u.username === r.id) : undefined;
        const name = agent?.name || user?.display_name || r.name;
        return <div className="ago-reactor" key={`${r.type}:${r.id}`}>
          <ReactorAvatar type={r.type} name={name} avatar={agent?.avatar} />
          <span><b>{name}</b><small>@{r.id} · {r.type}</small></span>
        </div>;
      })}
    </div>
  </div>, document.body);
}

function ReactorAvatar({ type, name, avatar }: { type: "user" | "agent"; name: string; avatar?: string | null }) {
  const [failed, setFailed] = useState(false);
  return <span className={`ago-reactor-av ${type}${avatar && !failed ? " has-avatar" : ""}`}>
    {avatar && !failed
      ? <img src={withToken(avatar)} alt="" onError={() => setFailed(true)} />
      : type === "agent" ? <Icon name="bot" /> : name[0]?.toUpperCase()}
  </span>;
}
