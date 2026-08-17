/* Persisted App Store review prompting counters. Same JSON-file pattern as
   prefs.ts — nothing here is secret, and the math needs to survive relaunches. */

import * as FileSystem from "expo-file-system/legacy";
import { create } from "zustand";

const REVIEW_FILE = `${FileSystem.documentDirectory ?? ""}store-review.json`;

export interface PersistedReview {
  firstLaunchAt: number | null;
  sessionCount: number;
  positiveEvents: number;
  lastPromptedVersion: string | null;
  lastPromptedAt: number | null;
  promptCount: number;
}

interface ReviewState extends PersistedReview {
  loaded: boolean;
  load: () => Promise<void>;
  incrementPositive: () => void;
  markPrompted: (version: string, at: number) => void;
}

function snapshot(state: ReviewState): PersistedReview {
  return {
    firstLaunchAt: state.firstLaunchAt,
    sessionCount: state.sessionCount,
    positiveEvents: state.positiveEvents,
    lastPromptedVersion: state.lastPromptedVersion,
    lastPromptedAt: state.lastPromptedAt,
    promptCount: state.promptCount,
  };
}

function persist(state: ReviewState): void {
  FileSystem.writeAsStringAsync(REVIEW_FILE, JSON.stringify(snapshot(state))).catch(
    () => {
      /* best-effort */
    },
  );
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asNullableNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asNullableString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** One session bump per JS process so remounts / reloads don't inflate counts. */
let sessionCountedThisProcess = false;

export const useReview = create<ReviewState>((set, get) => ({
  loaded: false,
  firstLaunchAt: null,
  sessionCount: 0,
  positiveEvents: 0,
  lastPromptedVersion: null,
  lastPromptedAt: null,
  promptCount: 0,

  async load() {
    let data: Partial<PersistedReview> = {};
    try {
      const text = await FileSystem.readAsStringAsync(REVIEW_FILE);
      data = JSON.parse(text) as Partial<PersistedReview>;
    } catch {
      /* first run or corrupt — treat as empty */
    }

    const firstLaunchAt =
      asNullableNumber(data.firstLaunchAt) ?? Date.now();
    let sessionCount = asNumber(data.sessionCount, 0);
    if (!sessionCountedThisProcess) {
      sessionCountedThisProcess = true;
      sessionCount += 1;
    }

    set({
      loaded: true,
      firstLaunchAt,
      sessionCount,
      positiveEvents: asNumber(data.positiveEvents, 0),
      lastPromptedVersion: asNullableString(data.lastPromptedVersion),
      lastPromptedAt: asNullableNumber(data.lastPromptedAt),
      promptCount: asNumber(data.promptCount, 0),
    });
    persist(get());
  },

  incrementPositive() {
    if (!get().loaded) return;
    set({ positiveEvents: get().positiveEvents + 1 });
    persist(get());
  },

  markPrompted(version, at) {
    if (!get().loaded) return;
    set({
      lastPromptedVersion: version,
      lastPromptedAt: at,
      promptCount: get().promptCount + 1,
    });
    persist(get());
  },
}));

/** Test-only: reset the per-process session latch. */
export function resetReviewSessionLatchForTests(): void {
  sessionCountedThisProcess = false;
}
