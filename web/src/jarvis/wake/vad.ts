/* A cheap energy gate for the wake word: the models only run while something
   louder than the room is going on. It decides per 10 ms block from the RMS
   level against an adaptive noise floor, opens on the first loud block and
   stays open for a hangover, so the tail of a phrase is never cut off. The
   engine replays a pre-roll of features when it opens, so the gate's latency
   costs nothing (see engine.ts). */

export interface VadOptions {
  /** Never open below this level, dBFS. */
  minDb?: number;
  /** Open this many dB above the tracked noise floor. */
  marginDb?: number;
  /** Stay open this long after the last loud block, ms. */
  hangoverMs?: number;
  /** How fast the floor rises toward a steady louder room, dB per second. */
  floorRiseDbPerSec?: number;
}

export const VAD_DEFAULTS: Required<VadOptions> = {
  minDb: -62,
  marginDb: 9,
  hangoverMs: 1000,
  floorRiseDbPerSec: 3,
};

const BLOCK_MS = 10;

export function rmsDb(samples: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / Math.max(1, samples.length)) / 32768;
  return rms > 0 ? 20 * Math.log10(rms) : -120;
}

export class EnergyVad {
  private readonly opts: Required<VadOptions>;
  private floorDb = Number.NaN; // learned from the first block
  private hangLeft = 0;
  private _levelDb = -120;

  constructor(options: VadOptions = {}) {
    this.opts = { ...VAD_DEFAULTS, ...options };
  }

  get open(): boolean {
    return this.hangLeft > 0;
  }
  get levelDb(): number {
    return this._levelDb;
  }
  get noiseFloorDb(): number {
    return this.floorDb;
  }

  /** One 10 ms block; returns whether the gate is open after it. */
  push(block: Int16Array): boolean {
    const db = rmsDb(block);
    this._levelDb = db;
    if (Number.isNaN(this.floorDb)) this.floorDb = db;
    const threshold = Math.max(this.opts.minDb, this.floorDb + this.opts.marginDb);
    if (db > threshold) {
      this.hangLeft = Math.round(this.opts.hangoverMs / BLOCK_MS);
    } else if (this.hangLeft > 0) {
      this.hangLeft--;
    }
    // The floor drops at once to anything quieter and creeps up slowly, so
    // speech never drags it up but a fan that starts is learned in seconds.
    if (db < this.floorDb) this.floorDb = db;
    else this.floorDb = Math.min(db, this.floorDb + (this.opts.floorRiseDbPerSec * BLOCK_MS) / 1000);
    return this.open;
  }

  reset(): void {
    this.floorDb = Number.NaN;
    this.hangLeft = 0;
    this._levelDb = -120;
  }
}
