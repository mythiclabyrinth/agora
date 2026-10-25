/* Header "Jarvis mode" chip: toggles the per-device mode (which arms the
   wake word, JarvisWakeHost) and opens the panel. Hidden unless
   /api/me advertises `jarvis`; admins get the server's hint (switch it on,
   or give its provider a credential) and a hop to Settings → Features. */

import { ThinkingOrb } from "thinking-orbs";
import { ariaCombo, currentPlatform, formatCombo, useMe } from "@agora/core";
import { toast } from "../../lib/toast";
import { useAppearance } from "../../state/appearance";
import { useJarvis } from "../../state/jarvis";
import { bindingFor, useShortcutState } from "../../state/shortcuts";
import { useUiState } from "../../state/ui";
import { JARVIS_WAKE_MODEL } from "../wake/JarvisWakeHost";
import { orbLook } from "./orbState";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";
import { Icon } from "../../lib/icons";

export function JarvisChip() {
  const me = useMe().data;
  const reduced = usePrefersReducedMotion();
  const enabled = useJarvis(s => s.enabled);
  const phase = useJarvis(s => s.phase);
  const wake = useJarvis(s => s.wake);
  const wakeError = useJarvis(s => s.wakeError);
  const isOpen = useJarvis(s => s.isOpen);
  const theme = useAppearance(a => a.resolved);
  useShortcutState(s => s.bindings);
  if (!me) return null;
  if (!me.jarvis) {
    if (!me.instance_admin || !me.jarvis_hint) return null;
    return (
      <button className="jv-chip is-unavailable" title={me.jarvis_hint}
        onClick={() => {
          toast(me.jarvis_hint || "Set up Jarvis under Settings → Features", { actionLabel: "Open settings",
            onAction: () => {
              // The Jarvis section is where both fixes start (switch, provider, Credentials hop).
              useUiState.getState().setSettingsTab("features");
              useUiState.getState().openPanel("settings");
            } });
        }}>
        Jarvis mode
      </button>
    );
  }
  const combo = bindingFor("jarvis.open", currentPlatform());
  const key = formatCombo(combo, currentPlatform());
  const look = orbLook(phase);
  const hint = !enabled ? `Turn on Jarvis mode and say “${JARVIS_WAKE_MODEL.phrase}”`
    : wake === "error" ? wakeError || "The wake word stopped"
    : wake === "listening" ? `Listening for “${JARVIS_WAKE_MODEL.phrase}” — click to open the assistant, right-click to turn off`
    : wake === "starting" ? "Waiting for the microphone… — right-click to turn off"
    : "Click to open the assistant, right-click to turn Jarvis mode off";
  // With the panel closed the chip is where a background request shows:
  // what Jarvis is doing, and an unmistakable ring while it hears you.
  const capturing = enabled && !isOpen && (phase === "listening" || phase === "recording");
  const label = !enabled || isOpen ? "Jarvis mode"
    : capturing ? "Listening…"
    : phase === "transcribing" || phase === "thinking" || phase === "searching" || phase === "composing" || phase === "weaving" ? "Thinking…"
    : phase === "speaking" ? "Speaking…"
    : "Jarvis mode";
  return (
    <button className={`jv-chip${enabled ? " is-on" : ""}${enabled && wake === "error" ? " is-error" : ""}${capturing ? " is-capturing" : ""}`}
      aria-pressed={enabled ? undefined : false} aria-expanded={enabled ? isOpen : undefined} aria-label="Jarvis mode"
      aria-keyshortcuts={ariaCombo(combo, currentPlatform())}
      title={`${hint}${key ? ` · ${key} opens the assistant` : ""}`}
      onClick={() => {
        const st = useJarvis.getState();
        // Off: turn it on and open. On: the chip is the way back to the
        // conversation, so it opens (or closes) the panel; turning the mode
        // off is deliberate (right-click, or the panel's switch).
        if (!enabled) { st.setEnabled(true); st.open(); return; }
        if (st.isOpen) st.close(); else st.open();
      }}
      onContextMenu={event => {
        if (!enabled) return;
        event.preventDefault();
        useJarvis.getState().setEnabled(false);
        toast("Jarvis mode is off", { variant: "ok" });
      }}>
      {enabled && <ThinkingOrb state={look.state} size={20} paused={look.paused || reduced} theme={theme} aria-hidden="true" />}
      {!enabled && <Icon name="sparkles" />}
      <span>{label}</span>
      {enabled && <span className={`jv-chip-signal${wake === "error" ? " is-error" : ""}`} aria-hidden="true" />}
    </button>
  );
}
