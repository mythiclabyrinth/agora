import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { watchAnchoredOverlay } from "../lib/anchoredOverlay";
import { Icon } from "../lib/icons";

export function AccessScopeSelect({ summary, wholeGroup, channels, selected, onToggle }: {
  summary: string;
  wholeGroup: boolean;
  channels: { id: string; name: string }[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const anchor = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => { anchor.current?.focus(); }, []);
  useLayoutEffect(() => {
    if (!open || !anchor.current || !popover.current) return;
    popover.current.style.width = `${Math.min(360, Math.max(260, anchor.current.offsetWidth), window.innerWidth - 24)}px`;
    return watchAnchoredOverlay(anchor.current, popover.current, "start");
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!popover.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return <div className="ago-access-select" onKeyDown={event => {
    if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); anchor.current?.focus(); }
  }}>
    <button ref={anchor} type="button" className="ago-access-trigger" aria-label="Choose access"
      aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { setQuery(""); setOpen(value => !value); }}>{summary}<Icon name="chevron-down" /></button>
    {open && <div ref={popover} id={id} className="ago-access-popover" role="group" aria-label="Access scopes">
      {channels.length > 5 && <input autoFocus className="ago-access-search" aria-label="Search channels" placeholder="Find a channel…" value={query} onChange={event => setQuery(event.target.value)} />}
      <div className="ago-access-options">
        {wholeGroup && !query && <label><input type="checkbox" aria-label="Whole group" checked={selected.includes("")} onChange={() => onToggle("")} /><span>Whole group<small>All current and future channels</small></span></label>}
        {channels.filter(channel => channel.name.toLowerCase().includes(query.toLowerCase())).map(channel =>
          <label key={channel.id}><input type="checkbox" checked={selected.includes(channel.id)} onChange={() => onToggle(channel.id)} /><span>#{channel.name}</span></label>)}
        {query && !channels.some(channel => channel.name.toLowerCase().includes(query.toLowerCase())) && <p className="ago-member-hint">No matching channels</p>}
      </div>
      <button type="button" className="ago-access-done" onClick={() => { setOpen(false); anchor.current?.focus(); }}>Done</button>
    </div>}
  </div>;
}
