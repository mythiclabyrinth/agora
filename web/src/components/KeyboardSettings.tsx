import { useEffect, useState } from "react";
import { currentPlatform, eventCombo, findConflicts, formatCombo, SHORTCUTS, type Conflict } from "@agora/core";
import { bindingFor, useShortcutState } from "../state/shortcuts";
import { isDesktopShell } from "../lib/chime";

export function KeyboardSettings() {
  const bindings = useShortcutState(s => s.bindings);
  const setBinding = useShortcutState(s => s.setBinding);
  const resetBinding = useShortcutState(s => s.resetBinding);
  const resetAll = useShortcutState(s => s.resetAll);
  const [recording, setRecording] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<{ id: string; combo: string; duplicate: Conflict; reset?: boolean } | null>(null);
  useEffect(() => {
    if (pending) requestAnimationFrame(() => document.querySelector<HTMLElement>(".ago-shortcut-conflict button")?.focus());
  }, [pending]);
  const platform = currentPlatform();
  const desktop = isDesktopShell();
  const capture = (event: React.KeyboardEvent<HTMLButtonElement>, id: string) => {
    event.preventDefault(); event.stopPropagation();
    if (event.key === "Escape") { setRecording(null); setError(""); return; }
    if (event.key === "Backspace") { setBinding(id, null); setRecording(null); setError(""); return; }
    if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return;
    const combo = eventCombo(event, platform);
    const conflicts = findConflicts(id, combo, platform, bindings, desktop);
    const blocked = conflicts.find(c => c.kind === "blocked");
    if (blocked) { setError(blocked.message); return; }
    const duplicate = conflicts.find(c => c.kind === "duplicate");
    if (duplicate) { setPending({ id, combo, duplicate }); setRecording(null); setError(duplicate.message); return; }
    setBinding(id, combo); setRecording(null);
    setError(conflicts.find(c => c.kind === "warning")?.message ?? "");
  };
  return <div className="ago-keyboard-settings">
    <p className="conn-hint">Shortcuts are saved on this device. Press Escape to cancel, or Backspace to turn one off.</p>
    {SHORTCUTS.filter(s => s.rebindable && (!s.desktopOnly || desktop)).map(s => <div className="ago-shortcut-row" key={s.id}>
      <span>{s.label}<small>{s.section}</small></span>
      <span className="ago-shortcut-keys">
        <kbd>{formatCombo(bindingFor(s.id, platform), platform) || "Off"}</kbd>
        <button type="button" className="btn sm" aria-label={`Change ${s.label} shortcut`}
          data-capturing-shortcut={recording === s.id ? "" : undefined}
          onClick={() => { setRecording(s.id); setError(""); }}
          onKeyDown={recording === s.id ? event => capture(event, s.id) : undefined}>
          {recording === s.id ? "Press keys…" : "Change"}
        </button>
        <button type="button" className="btn sm" aria-label={`Reset ${s.label} shortcut`} onClick={() => {
          const conflict = resetBinding(s.id);
          if (conflict?.kind === "duplicate") setPending({ id: s.id, combo: s.keys[platform]!, duplicate: conflict, reset: true });
          else if (conflict) setError(conflict.message);
        }}>Reset</button>
      </span>
    </div>)}
    {error && <p className="ago-shortcut-error" role="alert">{error}</p>}
    {pending && <div className="ago-shortcut-conflict" role="alertdialog" aria-label="Shortcut conflict"
      data-capturing-shortcut onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setPending(null); setError(""); }
      }}>
      <p>{pending.duplicate.message}. Replace that binding?</p>
      <button className="btn sm" onClick={() => { setPending(null); setError(""); }}>Cancel</button>
      <button className="btn sm primary" onClick={() => {
        if (pending.reset) resetBinding(pending.id, pending.duplicate.withId);
        else setBinding(pending.id, pending.combo, pending.duplicate.withId);
        setPending(null); setRecording(null); setError("");
      }}>Replace</button>
    </div>}
    <button className="btn sm" onClick={() => { resetAll(); setError(""); }}>Reset all shortcuts</button>
  </div>;
}
