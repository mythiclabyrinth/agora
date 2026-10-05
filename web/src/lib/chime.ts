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

export function playChime(volume: number): void {
  if (volume <= 0) return;
  const ctx = audio;
  if (!ctx) return;
  if (ctx.state === "running") {
    schedule(ctx, volume);
    return;
  }
  void ctx.resume().then(() => {
    if (ctx.state === "running") schedule(ctx, volume);
  }).catch(() => {});
}

export function previewChime(volume: number): void {
  armChimeNow();
  playChime(volume);
}

function schedule(ctx: AudioContext, volume: number): void {
  try {
    const start = ctx.currentTime;
    const peak = 0.4 * (volume / 100) ** 2;
    for (const [offset, frequency] of [[0, 523], [0.065, 659]]) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      const at = start + offset;
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(peak, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.085);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.09);
    }
  } catch {
    // Audio output can disappear when devices change.
  }
}
