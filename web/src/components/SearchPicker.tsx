/* Single-choice dropdown for the search bar's filters. A native <select>
   lists every option at full height (macOS draws a scope list with dozens
   of channels taller than the screen), so this is a fixed-height listbox
   with an optional filter box and sticky group headings, anchored under its
   trigger — or a bottom sheet on phones. */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { watchAnchoredOverlay } from "../lib/anchoredOverlay";
import { Icon } from "../lib/icons";

export interface PickerOption {
  value: string;
  label: string;
  /** Icon name, or "#" for a channel. */
  icon?: string;
  /** A group heading (selectable: "all of" the group); its channels follow
      with `group` set to the heading's value. */
  heading?: boolean;
  group?: string;
  /** Screen-reader name when the visible label is terse ("Health" → "All of Health"). */
  ariaLabel?: string;
  /** Muted text on the right of the row. */
  hint?: string;
}

const PHONE = "(max-width: 640px)";

/** Keeps a heading with any matching channel and every channel of a
    matching heading, so a filtered list still reads as grouped. */
function filterOptions(options: PickerOption[], query: string): PickerOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  const hit = (o: PickerOption) => o.label.toLowerCase().includes(q);
  const groupsHit = new Set(options.filter(o => o.heading && hit(o)).map(o => o.value));
  const groupsWithChild = new Set(options.filter(o => o.group && hit(o)).map(o => o.group));
  return options.filter(o => o.heading
    ? groupsHit.has(o.value) || groupsWithChild.has(o.value)
    : o.group ? hit(o) || groupsHit.has(o.group) : hit(o));
}

export function SearchPicker({ id, title, value, options, triggerLabel, filterPlaceholder, align = "start", onChange, returnFocus }: {
  id: string;
  title: string;
  value: string;
  options: PickerOption[];
  /** Trigger text; defaults to the selected option's label. */
  triggerLabel?: string;
  /** Shows a filter box above the list. */
  filterPlaceholder?: string;
  align?: "start" | "end";
  onChange: (value: string) => void;
  /** Where focus goes after a choice; the trigger keeps it otherwise.
      Search hands it back to its input so Enter opens the highlighted
      result instead of reopening this list. */
  returnFocus?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [sheet, setSheet] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const shown = useMemo(() => filterOptions(options, query), [options, query]);
  const selected = options.find(o => o.value === value);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const choose = (o: PickerOption | undefined) => {
    if (!o) return;
    onChange(o.value);
    close(!returnFocus);
    returnFocus?.();
  };
  const openList = () => {
    setQuery("");
    setActive(Math.max(0, options.findIndex(o => o.value === value)));
    setSheet(window.matchMedia(PHONE).matches);
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open || sheet || !trigger.current || !popover.current) return;
    return watchAnchoredOverlay(trigger.current, popover.current, align);
  }, [open, sheet, align]);
  useEffect(() => {
    if (!open) return;
    (filterRef.current ?? list.current)?.focus();
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popover.current?.contains(target) && !trigger.current?.contains(target)) close(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  // Keep the active row in view as the arrow keys move through a long list.
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, shown]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const last = shown.length - 1;
    const move = (to: number) => { event.preventDefault(); setActive(Math.max(0, Math.min(last, to))); };
    if (event.key === "ArrowDown") move(active + 1);
    else if (event.key === "ArrowUp") move(active - 1);
    else if (event.key === "Home" && !filterRef.current) move(0);
    else if (event.key === "End" && !filterRef.current) move(last);
    else if (event.key === "PageDown") move(active + 8);
    else if (event.key === "PageUp") move(active - 8);
    else if (event.key === "Enter") { event.preventDefault(); choose(shown[active]); }
    else if (event.key === "Escape") { event.preventDefault(); close(); }
    else if (event.key === "Tab") close(false);
  };

  return <>
    <button ref={trigger} type="button" id={id} className={`ago-search-scope ago-pick-trigger${value ? " set" : ""}`}
      title={title} aria-label={`${title}: ${triggerLabel ?? selected?.ariaLabel ?? selected?.label ?? ""}`}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
      onClick={() => open ? close(false) : openList()}
      onKeyDown={event => { if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); openList(); } }}>
      <span className="ago-pick-value">{triggerLabel ?? selected?.label}</span>
      <Icon name="chevron-down" />
    </button>
    {open && <>
      {sheet && <div className="ago-pick-scrim" onPointerDown={() => close(false)} />}
      {/* `data-capturing-shortcut` keeps Escape and arrows here: the search
          dialog would otherwise close, or move its own result selection. */}
      <div ref={popover} className={`ago-pick${sheet ? " sheet" : ""}`} data-capturing-shortcut onKeyDown={onKeyDown}>
        {sheet && <div className="ago-pick-sheet-head"><span>{title}</span>
          <button type="button" className="ago-x" aria-label="Close" onClick={() => close()}><Icon name="x" /></button></div>}
        {filterPlaceholder && <div className="ago-pick-filter">
          <Icon name="search" />
          <input ref={filterRef} value={query} placeholder={filterPlaceholder} aria-label={filterPlaceholder}
            role="combobox" aria-expanded aria-controls={listId} aria-autocomplete="list"
            aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
            autoComplete="off" spellCheck={false}
            onChange={event => { setQuery(event.target.value); setActive(0); }} />
        </div>}
        <div ref={list} id={listId} className="ago-pick-list" role="listbox" aria-label={title} tabIndex={filterPlaceholder ? -1 : 0}
          aria-activedescendant={!filterPlaceholder && shown[active] ? `${listId}-${active}` : undefined}>
          {shown.map((o, index) => (
            <div key={o.value || "__all"} id={`${listId}-${index}`} data-index={index} role="option"
              aria-selected={o.value === value} aria-label={o.ariaLabel}
              className={`ago-pick-opt${o.heading ? " heading" : ""}${o.group ? " child" : ""}${index === active ? " active" : ""}`}
              onPointerMove={() => setActive(index)} onClick={() => choose(o)}>
              {o.icon === "#" ? <span className="ago-pick-ico hash">#</span>
                : o.icon ? <span className="ago-pick-ico"><Icon name={o.icon} /></span> : null}
              <span className="ago-pick-label">{o.label}</span>
              {o.hint && <span className="ago-pick-hint">{o.hint}</span>}
              {o.value === value && <span className="ago-pick-check"><Icon name="check" /></span>}
            </div>
          ))}
          {!shown.length && <div className="ago-pick-empty">No matches for “{query.trim()}”</div>}
        </div>
      </div>
    </>}
  </>;
}
