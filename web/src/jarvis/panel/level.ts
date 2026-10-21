/* Shared beam level, 0–1, for the panel's VoiceBeam. The voice loop sets
   `source` to the mic analyser while listening and the playback analyser
   while speaking (it returns null when neither is live); otherwise `bump` is
   called per streamed chunk and the getter decays toward a quiet floor so
   the glow "speaks" with the text. */

export const jarvisLevel = {
  target: 0,
  at: 0,
  source: null as null | (() => number | null),
  bump(strength = 0.55) {
    this.target = Math.min(1, strength + Math.random() * 0.3);
    this.at = performance.now();
  },
  get(): number {
    const live = jarvisLevel.source?.();
    if (live != null) return live;
    const age = performance.now() - jarvisLevel.at;
    return jarvisLevel.target * Math.exp(-age / 260);
  },
};
