/* Background unread polling — fallback when Expo push registration fails
   (simulator, denied permission, older builds). Prefer remote push; the
   signed-in shell only registers this task when push is unavailable.

   The snapshot also gets refreshed from the foreground groups cache (see the
   UnreadSync component), so reading messages in-app suppresses stale banners. */

import * as FileSystem from "expo-file-system/legacy";
import * as TaskManager from "expo-task-manager";
import * as BackgroundTask from "expo-background-task";
import type { Group } from "@agora/core";
import { currentStoredSession } from "./notificationRegistration";
import { notifyUnreadChannel } from "./notifications";
import {
  channelsToNotify,
  snapshotOf,
  unreadChannels,
  type UnreadSnapshot,
} from "@agora/core";

const TASK_NAME = "agora-unread-poll";
const SNAPSHOT_FILE = `${FileSystem.documentDirectory ?? ""}unread-snapshot.json`;

async function readSnapshot(): Promise<UnreadSnapshot | null> {
  try {
    const text = await FileSystem.readAsStringAsync(SNAPSHOT_FILE);
    return JSON.parse(text) as UnreadSnapshot;
  } catch {
    return null; // first run (or unreadable) — baseline, don't notify
  }
}

async function writeSnapshot(snapshot: UnreadSnapshot): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(SNAPSHOT_FILE, JSON.stringify(snapshot));
  } catch {
    /* best-effort; worst case the next poll re-baselines */
  }
}

/** Foreground path: keep the snapshot current from the groups query cache. */
export function saveUnreadSnapshot(groups: Group[]): void {
  void writeSnapshot(snapshotOf(unreadChannels(groups)));
}

async function pollOnce(): Promise<void> {
  const session = await currentStoredSession();
  if (!session) return; // signed out
  const { baseUrl, token } = session;
  const res = await fetch(`${baseUrl}/api/groups`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return;
  const { groups } = (await res.json()) as { groups: Group[] };
  const channels = unreadChannels(groups);
  const prev = await readSnapshot();
  for (const notice of channelsToNotify(prev, channels)) {
    notifyUnreadChannel(notice.channel, notice.newCount, notice.newMentions);
  }
  await writeSnapshot(snapshotOf(channels));
}

// Module scope so the definition exists when the OS launches the app headless.
try {
  TaskManager.defineTask(TASK_NAME, async () => {
    try {
      await pollOnce();
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
} catch {
  /* platforms without task-manager support (web) */
}

/** Idempotent; safe to call on every sign-in. No-op where unavailable
    (web, simulators with Background App Refresh off, Expo Go). */
export async function registerBackgroundPolling(): Promise<void> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) return;
    await BackgroundTask.registerTaskAsync(TASK_NAME, { minimumInterval: 15 });
  } catch {
    /* unsupported platform — foreground notifications still work */
  }
}

/** Drop the poller once remote push is registered. */
export async function unregisterBackgroundPolling(): Promise<void> {
  try {
    await BackgroundTask.unregisterTaskAsync(TASK_NAME);
  } catch {
    /* not registered */
  }
}
