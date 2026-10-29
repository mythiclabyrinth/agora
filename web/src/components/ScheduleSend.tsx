/* Scheduling a typed message from the composer: the quick "in …" presets the
   server configures, or a custom local date and time. Desktop opens it from
   the chevron beside Send as a menu; touch screens open it by long-pressing
   Send, as a bottom sheet. Times are the browser's own time zone. */

import { useEffect, useId, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  customRunAtError, defaultCustomRunAt, presetRunAt, schedulePresetLabel, scheduleTimeZoneNote, useSchedulePresets,
} from "@agora/core";
import { DateTimeWheel } from "./DateTimeWheel";
import { Icon } from "../lib/icons";

/** How long a touch must rest on Send before it schedules instead. */
export const LONG_PRESS_MS = 450;
/** A finger drifting further than this is a scroll, not a press. */
const LONG_PRESS_SLOP_PX = 10;

/** `<input type="datetime-local">` value for a unix-second instant, local time. */
export function toLocalInput(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? Math.round(ms / 1000) : null;
}

/** Long-press for touch and pen (mouse keeps its click). `consume()` tells the
    click that follows a long press to do nothing, so it never also sends. */
export function useLongPress(onLongPress: () => void, ms = LONG_PRESS_MS) {
  const timer = useRef<number | undefined>(undefined);
  const fired = useRef(false);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const latest = useRef(onLongPress);
  latest.current = onLongPress;
  const clear = () => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
    origin.current = null;
  };
  useEffect(() => clear, []);
  return {
    /** Forget a long press whose click never reached the button (the sheet
        opened over it), so the next keyboard activation still sends. */
    reset: () => { fired.current = false; },
    consume: () => {
      const was = fired.current;
      fired.current = false;
      return was;
    },
    handlers: {
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
        fired.current = false;
        if (e.pointerType === "mouse") return;
        clear();
        origin.current = { x: e.clientX, y: e.clientY };
        timer.current = window.setTimeout(() => {
          timer.current = undefined;
          fired.current = true;
          navigator.vibrate?.(10);
          latest.current();
        }, ms);
      },
      onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
        const o = origin.current;
        if (o && Math.hypot(e.clientX - o.x, e.clientY - o.y) > LONG_PRESS_SLOP_PX) clear();
      },
      onPointerUp: clear,
      onPointerCancel: clear,
      onPointerLeave: clear,
      // No callout / text-selection menu while holding the button.
      onContextMenu: (e: ReactMouseEvent) => e.preventDefault(),
    },
  };
}

/** The choices themselves, shared by the desktop menu and the phone sheet. */
export function ScheduleOptions({ onSchedule, onClose, pending, titleId, wheel }: {
  onSchedule: (runAt: number) => void;
  onClose: () => void;
  pending?: boolean;
  titleId?: string;
  /** Phones pick the custom time on an iOS-style wheel; desktop keeps the
      browser's date-time field. */
  wheel?: boolean;
}) {
  const presets = useSchedulePresets();
  const [custom, setCustom] = useState(false);
  // The custom time opens on the next whole local hour.
  const [at, setAt] = useState(() => toLocalInput(defaultCustomRunAt()));
  const [wheelAt, setWheelAt] = useState(() => defaultCustomRunAt());
  const [error, setError] = useState<string | null>(null);
  const [settling, setSettling] = useState(false);
  const customRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (custom) customRef.current?.focus(); }, [custom]);
  const submitCustom = () => {
    if (pending || settling) return;
    const runAt = wheel ? wheelAt : fromLocalInput(at);
    const problem = customRunAtError(runAt);
    if (problem) { setError(problem); return; }
    setError(null);
    onSchedule(runAt!);
  };
  return (
    <div className="ago-sched-send-body" aria-busy={!!pending}>
      <div className="ago-sched-send-head">
        <strong id={titleId}>Schedule message</strong>
        <span className="dim">{scheduleTimeZoneNote()}</span>
        <button type="button" className="ago-sched-send-close" aria-label="Close schedule options" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="ago-sched-send-list" role="group" aria-label="Send later">
        {presets.map(minutes => (
          <button key={minutes} type="button" className="ago-sched-send-opt" disabled={pending}
            onClick={() => onSchedule(presetRunAt(minutes))}>
            {schedulePresetLabel(minutes)}
          </button>
        ))}
      </div>
      <div className="ago-sched-send-list">
        <button type="button" className={`ago-sched-send-opt ${custom ? "active" : ""}`} aria-expanded={custom}
          disabled={pending} onClick={() => { setSettling(false); setCustom(!custom); }}>
          Custom time
        </button>
        {custom && (
          <div className="ago-sched-send-custom">
            {wheel ? (
              <div inert={pending}>
                <DateTimeWheel runAt={wheelAt} onChange={v => { setWheelAt(v); setError(null); }} onSettlingChange={setSettling} />
              </div>
            ) : (
              <input ref={customRef} type="datetime-local" aria-label="Date and time" value={at} disabled={pending}
                min={toLocalInput(Date.now() / 1000)}
                onChange={e => { setAt(e.target.value); setError(null); }}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); submitCustom(); } }} />
            )}
            {error && <div className="ago-sched-error" role="alert">{error}</div>}
            <button type="button" className="btn primary ago-sched-send-go" disabled={pending || settling} onClick={submitCustom}>
              {pending ? "Scheduling…" : "Schedule message"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Desktop: a menu anchored above the Send group; closes on Escape or a
    click elsewhere. */
export function ScheduleMenu({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // Latest onClose via a ref: callers pass an inline closure, and re-running
  // the effect on each render would steal focus back to the first preset.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const menu = ref.current;
    const outside = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t && !ref.current?.contains(t) && !t.closest(".ago-send-more")) closeRef.current();
    };
    document.addEventListener("pointerdown", outside, true);
    const frame = requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(".ago-sched-send-opt")?.focus());
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", outside, true);
      if (opener?.isConnected && (menu?.contains(document.activeElement) || document.activeElement === document.body)) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);
  return (
    <div ref={ref} className="ago-sched-send-menu" role="dialog" aria-label="Schedule message"
      onBlur={e => {
        if (e.relatedTarget instanceof Element && !e.currentTarget.contains(e.relatedTarget)
          && !e.relatedTarget.closest(".ago-send-more")) closeRef.current();
      }}
      onKeyDown={e => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          const opts = [...(ref.current?.querySelectorAll<HTMLElement>(".ago-sched-send-opt") ?? [])];
          const i = opts.indexOf(document.activeElement as HTMLElement);
          if (i < 0) return;
          e.preventDefault();
          opts[(i + (e.key === "ArrowDown" ? 1 : opts.length - 1)) % opts.length]?.focus();
        }
      }}>
      {children}
    </div>
  );
}

/** Phones: a modal bottom sheet in the top layer (inert background). */
export function ScheduleSheet({ onClose, children, titleId }: { onClose: () => void; children: ReactNode; titleId: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const backdropPress = useRef(false);
  // The sheet opens under the finger still holding Send: ignore pointer clicks
  // until a fresh press starts inside it, so lifting never picks an option.
  // Keyboard activation (detail 0) is always allowed.
  const armed = useRef(false);
  useEffect(() => {
    const dialog = ref.current!;
    if (!dialog.open) dialog.showModal?.();
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  return createPortal(
    <dialog ref={ref} className="ago-sched-send-sheet" aria-labelledby={titleId}
      onCancel={e => { e.preventDefault(); onClose(); }}
      onPointerDownCapture={() => { armed.current = true; }}
      onClickCapture={e => { if (!armed.current && e.detail !== 0) { e.preventDefault(); e.stopPropagation(); } }}
      onPointerDown={e => { backdropPress.current = e.target === e.currentTarget; }}
      onPointerCancel={() => { backdropPress.current = false; }}
      onClick={e => {
        if (backdropPress.current && e.target === e.currentTarget) onClose();
        backdropPress.current = false;
      }}>
      <div className="ago-sched-send-grip" aria-hidden="true" />
      <div onKeyDown={e => e.stopPropagation()}>{children}</div>
    </dialog>,
    document.body,
  );
}

/** Where the schedule UI is open: nowhere, the desktop menu, or the sheet. */
export type ScheduleSurface = null | "menu" | "sheet";

export function ScheduleSurfaceView({ surface, onClose, onSchedule, pending }: {
  surface: ScheduleSurface;
  onClose: () => void;
  onSchedule: (runAt: number) => void;
  pending?: boolean;
}) {
  const titleId = useId();
  if (!surface) return null;
  const body = <ScheduleOptions onSchedule={onSchedule} onClose={onClose} pending={pending} titleId={titleId} wheel={surface === "sheet"} />;
  return surface === "menu"
    ? <ScheduleMenu onClose={onClose}>{body}</ScheduleMenu>
    : <ScheduleSheet onClose={onClose} titleId={titleId}>{body}</ScheduleSheet>;
}
