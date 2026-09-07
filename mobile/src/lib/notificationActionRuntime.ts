import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { notificationCategories, parseNotificationActions } from "@agora/core/src/notifications/actions";
import { executeNotificationAction } from "./notificationActionExecutor";
import { currentStoredSession, readActionRegistration } from "./notificationRegistration";

const TASK = "agora-notification-actions-v1";
const inFlight = new Map<string, Promise<void>>();
let installed = false;
let setup: Promise<boolean> | null = null;

async function credentials() {
  const [session, registration] = await Promise.all([currentStoredSession(), readActionRegistration()]);
  return session && registration ? { session, registration } : null;
}

async function respond(response: Notifications.NotificationResponse) {
  const { content, identifier } = response.notification.request;
  const envelope = parseNotificationActions(content.data);
  if (!envelope) return;
  const result = await executeNotificationAction(content.data, response.actionIdentifier, credentials)
    .catch(() => "retry" as const);
  if (result === "ignored") return;
  const current = await credentials().catch(() => null);
  // Sign-out clears notifications; a late network callback must not recreate
  // another account's card after that cleanup.
  if (current?.registration.context !== envelope.context) return;
  const retry = result === "retry";
  const data: Record<string, unknown> = { ...content.data, notification_context: envelope.context };
  if (!retry) {
    delete data.notification_actions;
    data.pending_interaction = result === "open";
  }
  await Notifications.scheduleNotificationAsync({
    identifier,
    content: {
      title: result === "recorded" ? "Response sent" : result === "handled" ? "Already handled" :
        retry ? "Could not confirm — retry or open Agora" : "Open Agora to review this request",
      body: content.body,
      data,
      categoryIdentifier: retry ? envelope.category : undefined,
      sound: false,
    },
    trigger: null,
  });
}

function handle(response: Notifications.NotificationResponse): Promise<void> {
  if (!response.actionIdentifier?.startsWith("agora.action.")) return Promise.resolve();
  const key = `${response.notification.request.identifier}:${response.actionIdentifier}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const work = respond(response).catch(() => {}).finally(() => { inFlight.delete(key); });
  inFlight.set(key, work);
  return work;
}

/** Imported by index.js before the router so Android can load the task when
    the UI is absent. iOS remains tap-to-open until the native handler ships. */
export function installNotificationActionHandlers() {
  if (installed || Platform.OS !== "android") return;
  installed = true;
  TaskManager.defineTask<Notifications.NotificationTaskPayload>(TASK, async ({ data, error }) => {
    if (!error && data && "actionIdentifier" in data) await handle(data);
  });
  Notifications.addNotificationResponseReceivedListener((response) => { void handle(response); });
}

export async function setupNotificationActions(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  if (!setup) {
    setup = (async () => {
      installNotificationActionHandlers();
      // Category registration is read-modify-write on some platforms.
      for (const category of notificationCategories) {
        await Notifications.setNotificationCategoryAsync(category.identifier, category.actions);
      }
      await Notifications.registerTaskAsync(TASK);
      return true;
    })().catch(() => { setup = null; return false; });
  }
  return setup;
}
