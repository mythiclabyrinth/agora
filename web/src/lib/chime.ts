import { useUiState } from "../state/ui";

/** Shell-owned marker works for both embedded and remote webview URLs. */
export function isDesktopShell(): boolean {
  return (window as Window & { __AGORA_DESKTOP__?: boolean }).__AGORA_DESKTOP__ === true;
}

let audio: AudioContext | null = null;

/** Browsers and WebKit may require a user gesture before audio can play. */
export function armChime(): () => void {
  window.addEventListener("pointerdown", armChimeNow, { passive: true });
  window.addEventListener("keydown", armChimeNow);
  return () => {
    window.removeEventListener("pointerdown", armChimeNow);
    window.removeEventListener("keydown", armChimeNow);
  };
}

export function armChimeNow(): void {
  if (!useUiState.getState().soundEnabled) return;
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume().catch(() => {});
  } catch {
    // A missing or blocked audio device must not interrupt messaging.
  }
}

export function playChime(): void {
  if (!audio || audio.state !== "running") return;
  try {
    const start = audio.currentTime;
    for (const [offset, frequency] of [[0, 523], [0.065, 659]]) {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const at = start + offset;
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.035, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.085);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.09);
    }
  } catch {
    // Audio output can disappear when devices change.
  }
}
