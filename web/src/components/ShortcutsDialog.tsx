import { useEffect, useState } from "react";
import { currentPlatform, formatCombo, SHORTCUTS, useMe, type Platform } from "@agora/core";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { bindingFor, useShortcutState } from "../state/shortcuts";
import { useUiState } from "../state/ui";
import { Icon } from "../lib/icons";
import { isDesktopShell } from "../lib/chime";

export function ShortcutsDialog({ platformOverride }: { platformOverride?: Platform } = {}) {
  const open = useShortcutState(s => s.sheetOpen);
  useShortcutState(s => s.bindings);
  const setOpen = useShortcutState(s => s.setSheetOpen);
  const [filter, setFilter] = useState("");
  useEffect(() => { if (!open) setFilter(""); }, [open]);
  const me = useMe().data;
  const setSettingsTab = useUiState(s => s.setSettingsTab);
  const openPanel = useUiState(s => s.openPanel);
  const ref = useDialogFocus(open, () => setOpen(false));
  if (!open) return null;
  const platform = platformOverride ?? currentPlatform();
  const desktop = isDesktopShell();
  const rows = SHORTCUTS.filter(s => (!s.feature || !!me?.[s.feature]) && (!s.desktopOnly || desktop) &&
    `${s.label} ${s.section} ${s.id}`.toLowerCase().includes(filter.toLowerCase()));
  const sections = [...new Set(rows.map(s => s.section))];
  return <div className="conn-overlay" onMouseDown={e => { if (e.target === e.currentTarget) setOpen(false); }}>
    <div ref={ref} className="conn-panel ago-shortcuts-panel" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" tabIndex={-1}>
      <div className="conn-head"><b>Keyboard shortcuts</b><button className="btn sm" aria-label="Close keyboard shortcuts" onClick={() => setOpen(false)}><Icon name="x" /></button></div>
      <div className="conn-body">
        <input className="ago-shortcut-filter" aria-label="Filter keyboard shortcuts" placeholder="Filter shortcuts…" value={filter} onChange={e => setFilter(e.target.value)} />
        {sections.map(section => <section key={section} className="ago-shortcut-section"><h3>{section}</h3>
          {rows.filter(s => s.section === section).map(s => {
            const combo = bindingFor(s.id, platform);
            return <div className="ago-shortcut-row" key={s.id}>
              <span>{s.label}{s.scope === "thread" && <small>In thread</small>}{s.scope === "recording" && <small>While recording</small>}{s.desktopOnly && <small>Desktop</small>}</span>
              <span className="ago-shortcut-keys">{combo ? <kbd>{s.id === "focus.composer" ? "Type or " : ""}{formatCombo(combo, platform)}</kbd> : s.rebindable ? <em>Off</em> : null}{s.sequence && <kbd>{s.sequence}</kbd>}</span>
            </div>;
          })}</section>)}
        {!rows.length && <p className="dim">No matching shortcuts.</p>}
        <button className="btn sm" onClick={() => { setOpen(false); setSettingsTab("keyboard"); if (useUiState.getState().panel !== "settings") openPanel("settings"); }}>Customize shortcuts…</button>
      </div>
    </div>
  </div>;
}
