/* In-app App Store review prompting. Every StoreReview / write-review call
   goes through this module so gating stays in one place. Positive moments
   only *record* an event; the system prompt is deferred to the next screen
   exit or app foreground so it never interrupts the thing the user liked. */

import * as Application from "expo-application";
import * as StoreReview from "expo-store-review";
import { Linking } from "react-native";
import type { QueryClient } from "@tanstack/react-query";
import {
  flattenMessages,
  keys,
  type Message,
  type MessagePages,
} from "@agora/core";
import {
  useReview,
  type PersistedReview,
} from "../state/review";

export const APP_STORE_ID = "6791784699";
export const APP_STORE_WRITE_REVIEW_URL =
  `https://apps.apple.com/app/id${APP_STORE_ID}?action=write-review`;

export const POSITIVE_REACTION_EMOJIS = new Set(["👍", "❤️", "🎉"]);

const DAY_MS = 24 * 60 * 60 * 1000;
export const MIN_POSITIVE_EVENTS = 2;
export const MIN_SESSIONS = 3;
export const MIN_DAYS_SINCE_FIRST_LAUNCH = 3;
export const MIN_DAYS_BETWEEN_PROMPTS = 90;
export const MAX_LIFETIME_PROMPTS = 2;

/** In-memory only — survives until the next deferred flush attempt. */
let pendingPrompt = false;
let voiceCallActive = false;
let sheetDepth = 0;
let loadPromise: Promise<void> | null = null;

export type ReviewGateInput = Pick<
  PersistedReview,
  | "firstLaunchAt"
  | "sessionCount"
  | "positiveEvents"
  | "lastPromptedVersion"
  | "lastPromptedAt"
  | "promptCount"
> & { loaded?: boolean };

/** Pure gate used by both runtime and unit tests. */
export function canRequestReview(
  state: ReviewGateInput,
  opts: { now: number; version: string },
): boolean {
  if (state.loaded === false) return false;
  if (state.positiveEvents < MIN_POSITIVE_EVENTS) return false;
  if (state.sessionCount < MIN_SESSIONS) return false;
  if (
    state.firstLaunchAt == null ||
    opts.now - state.firstLaunchAt < MIN_DAYS_SINCE_FIRST_LAUNCH * DAY_MS
  ) {
    return false;
  }
  if (state.promptCount >= MAX_LIFETIME_PROMPTS) return false;
  if (state.lastPromptedVersion === opts.version) return false;
  if (
    state.lastPromptedAt != null &&
    opts.now - state.lastPromptedAt < MIN_DAYS_BETWEEN_PROMPTS * DAY_MS
  ) {
    return false;
  }
  return true;
}

/** True when the most recent human message before this agent reply is ours. */
export function agentReplyFollowsUser(
  messages: Message[],
  agent: Message,
  username: string,
): boolean {
  if (!username || agent.author_type !== "agent") return false;
  const priorHumans = messages
    .filter((m) => m.id < agent.id && m.author_type === "user")
    .sort((a, b) => b.id - a.id);
  const last = priorHumans[0];
  return !!last && last.author_id === username;
}

export function agentReplyFollowsUserInCache(
  qc: QueryClient,
  agent: Message,
  username: string,
): boolean {
  const data = qc.getQueryData<MessagePages>(
    keys.messages(agent.channel_id, agent.thread_id),
  );
  return agentReplyFollowsUser(flattenMessages(data), agent, username);
}

async function ensureLoaded(): Promise<void> {
  if (useReview.getState().loaded) return;
  if (!loadPromise) loadPromise = useReview.getState().load();
  try {
    await loadPromise;
  } finally {
    loadPromise = null;
  }
}

export async function initStoreReview(): Promise<void> {
  await ensureLoaded();
}

/** Mark a value moment. Does not show the prompt — call flush later. */
export async function recordPositiveEvent(): Promise<void> {
  await ensureLoaded();
  useReview.getState().incrementPositive();
  pendingPrompt = true;
}

export function setReviewVoiceActive(active: boolean): void {
  voiceCallActive = active;
}

export function beginReviewUiBlock(): void {
  sheetDepth += 1;
}

export function endReviewUiBlock(): void {
  sheetDepth = Math.max(0, sheetDepth - 1);
}

function installedVersion(): string {
  return Application.nativeApplicationVersion ?? "0.0.0";
}

/**
 * Attempt the system review prompt if a positive event left a pending flag
 * and every gate / UI blocker passes. Safe to call often.
 */
export async function flushDeferredReviewPrompt(): Promise<boolean> {
  if (!pendingPrompt) return false;
  if (voiceCallActive || sheetDepth > 0) return false;

  await ensureLoaded();
  const version = installedVersion();
  const state = useReview.getState();
  if (!canRequestReview(state, { now: Date.now(), version })) return false;

  const available = await StoreReview.isAvailableAsync();
  if (!available) return false;
  const hasAction = await StoreReview.hasAction();
  if (!hasAction) return false;

  // Consume the pending flag and record the attempt before showing — Apple
  // may silently no-op once the yearly quota is hit, and we still don't want
  // to retry within the same version / 90-day window.
  pendingPrompt = false;
  useReview.getState().markPrompted(version, Date.now());
  await StoreReview.requestReview();
  return true;
}

/** Open the public write-review URL (settings row). Never call requestReview
    from a user-initiated control — Apple rejects / silently no-ops that. */
export function openWriteReviewUrl(): Promise<void> {
  return Linking.openURL(APP_STORE_WRITE_REVIEW_URL).then(() => undefined);
}

/** Test helpers */
export function resetStoreReviewRuntimeForTests(): void {
  pendingPrompt = false;
  voiceCallActive = false;
  sheetDepth = 0;
  loadPromise = null;
}

export function getStoreReviewRuntimeForTests(): {
  pendingPrompt: boolean;
  voiceCallActive: boolean;
  sheetDepth: number;
} {
  return { pendingPrompt, voiceCallActive, sheetDepth };
}
