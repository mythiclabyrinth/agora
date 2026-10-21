/* Header "Jarvis mode" chip: toggles the per-device mode (which arms the
   wake word, JarvisWakeHost) and opens the panel. Hidden unless
   /api/me advertises `jarvis`; admins get a hint to connect ChatGPT. */

import { ThinkingOrb } from "thinking-orbs";
import { ariaCombo, currentPlatform, formatCombo, useMe } from "@agora/core";
import { toast } from "../../lib/toast";
import { useAppearance } from "../../state/appearance";
import { useJarvis } from "../../state/jarvis";
import { bindingFor, useShortcutState } from "../../state/shortcuts";
import { useUiState } from "../../state/ui";
import { JARVIS_WAKE_MODEL } from "../wake/JarvisWakeHost";
import { orbLook } from "./orbState";

export function JarvisChip() {
  const me = useMe().data;
  const enabled = useJarvis(s => s.enabled);
  const phase = useJarvis(s => s.phase);
  const wake = useJarvis(s => s.wake);
  const wakeError = useJarvis(s => s.wakeError);
  const theme = useAppearance(a => a.resolved);
  useShortcutState(s => s.bindings);
  if (!me) return null;
  if (!me.jarvis) {
    if (!me.instance_admin || !me.jarvis_hint) return null;
    return (
      <button className="jv-chip is-unavailable" title={me.jarvis_hint}
        onClick={() => {
          toast(me.jarvis_hint || "Connect ChatGPT to enable Jarvis mode", { actionLabel: "Open settings",
            onAction: () => useUiState.getState().openPanel("settings") });
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
    : wake === "listening" ? `Listening for “${JARVIS_WAKE_MODEL.phrase}” — click to turn off`
    : wake === "starting" ? "Waiting for the microphone… — click to turn off"
    : "Turn off Jarvis mode";
  return (
    <button className={`jv-chip${enabled ? " is-on" : ""}${enabled && wake === "error" ? " is-error" : ""}`} aria-pressed={enabled}
      aria-keyshortcuts={ariaCombo(combo, currentPlatform())}
      title={`${hint}${key ? ` · ${key} opens the assistant` : ""}`}
      onClick={() => {
        const st = useJarvis.getState();
        st.setEnabled(!enabled);
        if (!enabled) st.open(); else st.close();
      }}>
      {enabled && <ThinkingOrb state={look.state} size={20} paused={look.paused} theme={theme} aria-hidden="true" />}
      <span>Jarvis mode</span>
    </button>
  );
}
