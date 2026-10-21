/* Whether to mount the wake word dev panel (DevWakePanel.tsx). Kept apart so
   the check costs the main bundle a few bytes and the panel stays lazy.

   ?wakeDebug=1 turns it on and remembers it (localStorage); ?wakeDebug=0
   forgets it. VITE_WAKE_DEBUG=1 at build time turns it on for shells whose
   URL cannot be edited (the desktop app's embedded mode). */
export function wakeDebugEnabled(): boolean {
  const q = new URLSearchParams(location.search).get("wakeDebug");
  try {
    if (q === "1") localStorage.setItem("agora.wakeDebug", "1");
    if (q === "0") localStorage.removeItem("agora.wakeDebug");
    return import.meta.env.VITE_WAKE_DEBUG === "1" || localStorage.getItem("agora.wakeDebug") === "1";
  } catch {
    return q === "1";
  }
}
