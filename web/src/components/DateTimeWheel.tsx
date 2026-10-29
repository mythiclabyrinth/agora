/* An iOS-style date-and-time wheel for the phone schedule sheet: four
   scroll-snapping columns (day, hour, minute, AM/PM) behind one highlighted
   band, rows fading and shrinking away from it. Touch scrolls a column; a tap
   on a row or ArrowUp/ArrowDown on a focused column moves it one row. */

import { useEffect, useId, useMemo, useRef } from "react";
import { runAtToWheel, WHEEL_DAYS, wheelDayLabel, wheelToRunAt, type WheelValue } from "@agora/core";

/** Row height in px; the wheel shows five rows with the middle one selected. */
export const WHEEL_ROW = 36;
const VISIBLE = 5;
const PAD = WHEEL_ROW * Math.floor(VISIBLE / 2);

const HOURS = Array.from({ length: 12 }, (_, i) => i + 1);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);

function WheelColumn({ label, options, index, onIndex, onMoving, className }: {
  label: string;
  options: string[];
  index: number;
  onIndex: (i: number) => void;
  onMoving: (moving: boolean) => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const settle = useRef<number | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  // A finger (or wheel) is moving the column: hold off syncing to `index`.
  const scrolling = useRef(false);
  // The next scroll event is our own scrollTop write, not the user's.
  const programmatic = useRef<number | null>(null);
  const held = useRef(false);
  const latest = useRef({ onIndex, index, onMoving });
  latest.current = { onIndex, index, onMoving };
  const id = useId();

  // Fade and shrink rows by their distance from the band. Written straight to
  // the DOM per frame so scrolling 366 days never re-renders React.
  const paint = () => {
    frame.current = undefined;
    const el = ref.current;
    if (!el) return;
    const centre = el.scrollTop / WHEEL_ROW;
    const first = Math.max(0, Math.floor(centre) - VISIBLE);
    const last = Math.min(options.length - 1, Math.ceil(centre) + VISIBLE);
    for (let i = first; i <= last; i++) {
      const row = el.children[i] as HTMLElement | undefined;
      if (!row) continue;
      const dist = Math.min(Math.abs(i - centre), 3);
      row.style.opacity = String(1 - dist * 0.3);
      row.style.transform = `scale(${1 - dist * 0.09})`;
    }
  };

  // Follow the value from outside (open, keyboard, tap) without fighting a
  // scroll the finger is still driving.
  useEffect(() => {
    const el = ref.current;
    if (!el || scrolling.current) return;
    if (Math.round(el.scrollTop / WHEEL_ROW) !== index) {
      programmatic.current = index * WHEEL_ROW;
      el.scrollTop = index * WHEEL_ROW;
    }
    paint();
  });
  useEffect(() => () => {
    if (settle.current !== undefined) window.clearTimeout(settle.current);
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    latest.current.onMoving(false);
  }, []);

  const settleScroll = () => {
    if (settle.current !== undefined) window.clearTimeout(settle.current);
    // Snap has landed once the scroll goes quiet.
    settle.current = window.setTimeout(() => {
      if (held.current) return;
      scrolling.current = false;
      const el = ref.current;
      if (!el) return;
      const i = Math.min(options.length - 1, Math.max(0, Math.round(el.scrollTop / WHEEL_ROW)));
      if (i !== latest.current.index) latest.current.onIndex(i);
      latest.current.onMoving(false);
    }, 90);
  };
  const onScroll = () => {
    if (frame.current === undefined) frame.current = requestAnimationFrame(paint);
    const target = programmatic.current;
    programmatic.current = null;
    if (target !== null && Math.abs((ref.current?.scrollTop ?? 0) - target) < 1) return;
    scrolling.current = true;
    latest.current.onMoving(true);
    settleScroll();
  };

  // Keyboard and taps pick a row outright, cancelling any scroll in flight.
  const pick = (i: number) => {
    if (settle.current !== undefined) window.clearTimeout(settle.current);
    scrolling.current = false;
    if (ref.current) {
      programmatic.current = i * WHEEL_ROW;
      ref.current.scrollTop = i * WHEEL_ROW;
      paint();
    }
    if (i !== latest.current.index) latest.current.onIndex(i);
    latest.current.onMoving(false);
  };
  const step = (delta: number) => pick(Math.min(options.length - 1, Math.max(0, index + delta)));

  return (
    <div ref={ref} className={`ago-wheel-col ${className ?? ""}`} role="listbox" tabIndex={0} aria-label={label}
      aria-activedescendant={`${id}-${index}`} style={{ paddingBlock: PAD }}
      onScroll={onScroll}
      onPointerDown={() => {
        held.current = true;
        // Release is watched on the window: a pointer let go outside the
        // column must still end the hold, or the wheel never settles.
        const release = () => {
          window.removeEventListener("pointerup", release, true);
          window.removeEventListener("pointercancel", release, true);
          held.current = false;
          if (scrolling.current) settleScroll();
        };
        window.addEventListener("pointerup", release, true);
        window.addEventListener("pointercancel", release, true);
      }}
      onKeyDown={e => {
        if (e.key === "ArrowDown") { e.preventDefault(); step(1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); step(-1); }
        else if (e.key === "PageDown") { e.preventDefault(); step(VISIBLE); }
        else if (e.key === "PageUp") { e.preventDefault(); step(-VISIBLE); }
        else if (e.key === "Home") { e.preventDefault(); pick(0); }
        else if (e.key === "End") { e.preventDefault(); pick(options.length - 1); }
      }}>
      {options.map((text, i) => (
        <div key={i} id={`${id}-${i}`} role="option" aria-selected={i === index} className="ago-wheel-row"
          onClick={() => pick(i)}>
          {text}
        </div>
      ))}
    </div>
  );
}

/** The wheel for `runAt` (unix seconds, local time); every change reports the
    newly selected instant. Past times are allowed here and refused on submit,
    as with any picker. */
export function DateTimeWheel({ runAt, onChange, onSettlingChange, nowMs }: {
  runAt: number;
  onChange: (runAt: number) => void;
  onSettlingChange?: (settling: boolean) => void;
  /** Pinned "today" for stories and tests; defaults to the open time. */
  nowMs?: number;
}) {
  const openedAt = useRef(nowMs ?? Date.now());
  const now = nowMs ?? openedAt.current;
  const v = runAtToWheel(runAt, now);
  const current = useRef(v);
  current.current = v;
  const moving = useRef(new Set<string>());
  const onMoving = (column: string) => (active: boolean) => {
    if (active) moving.current.add(column);
    else moving.current.delete(column);
    onSettlingChange?.(moving.current.size > 0);
  };
  const days = useMemo(
    () => Array.from({ length: WHEEL_DAYS }, (_, i) => wheelDayLabel(i, now)),
    [now],
  );
  const set = (patch: Partial<WheelValue>) => {
    current.current = { ...current.current, ...patch };
    onChange(wheelToRunAt(current.current, now));
  };
  return (
    <div className="ago-wheel" role="group" aria-label="Date and time" style={{ height: WHEEL_ROW * VISIBLE }}>
      <div className="ago-wheel-band" aria-hidden="true" style={{ top: PAD, height: WHEEL_ROW }} />
      <WheelColumn label="Day" className="day" options={days} index={v.day} onIndex={day => set({ day })} onMoving={onMoving("day")} />
      <WheelColumn label="Hour" className="hour" options={HOURS.map(String)} index={v.hour12 - 1}
        onIndex={i => set({ hour12: i + 1 })} onMoving={onMoving("hour")} />
      <WheelColumn label="Minute" className="minute" options={MINUTES.map(m => String(m).padStart(2, "0"))}
        index={v.minute} onIndex={minute => set({ minute })} onMoving={onMoving("minute")} />
      <WheelColumn label="AM or PM" className="ampm" options={["AM", "PM"]} index={v.pm ? 1 : 0}
        onIndex={i => set({ pm: i === 1 })} onMoving={onMoving("ampm")} />
    </div>
  );
}
