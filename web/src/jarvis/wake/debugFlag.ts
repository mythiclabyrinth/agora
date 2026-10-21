/* Whether to mount the wake word dev panel (DevWakePanel.tsx). Kept apart so
   the check costs the main bundle a few bytes and the panel stays lazy.

   Only in dev servers (`vite`) or builds made with VITE_WAKE_DEBUG=1: the
   panel can open the mic outside Jarvis mode, so a link must not be able to
   switch it on in a production build. In dev, ?wakeDebug=1 turns it on and
   remembers it (localStorage); ?wakeDebug=0 forgets it. A VITE_WAKE_DEBUG=1
   build turns it on outright, for shells whose URL cannot be edited (the
   desktop app's embedded mode) and for tools/wake-wasm/browser-e2e.mjs. */
export function wakeDebugEnabled(): boolean {
  if (import.meta.env.VITE_WAKE_DEBUG === "1") return true;
  if (!import.meta.env.DEV) return false;
  const q = new URLSearchParams(location.search).get("wakeDebug");
  try {
    if (q === "1") localStorage.setItem("agora.wakeDebug", "1");
    if (q === "0") localStorage.removeItem("agora.wakeDebug");
    return localStorage.getItem("agora.wakeDebug") === "1";
  } catch {
    return q === "1";
  }
}
