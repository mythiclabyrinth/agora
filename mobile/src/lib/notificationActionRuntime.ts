import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { notificationCategories, parseNotificationActions } from "@agora/core/src/notifications/actions";
import { executeNotificationAction } from "./notificationActionExecutor";
import { currentStoredSession, readActionRegistration, registrationEpoch } from "./notificationRegistration";

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
  const started = registrationEpoch();
  let result = await executeNotificationAction(content.data, response.actionIdentifier, credentials)
    .catch(() => "open" as const);
  if (result === "ignored") return;
  const [session, registration] = await Promise.all([
    currentStoredSession().catch(() => null), readActionRegistration().catch(() => null),
  ]);
  // Sign-out clears notifications; a late network callback must not recreate
  // another account's card after that cleanup.
  if (started !== registrationEpoch() || (registration && (registration.context !== envelope.context ||
      (session && registration.baseUrl !== session.baseUrl)))) return;
  if (!session || !registration) result = "open";
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

/** Installed before the router: iOS handles warm-process responses through JS;
    Android additionally defines its headless task. No killed-iOS guarantee. */
export function installNotificationActionHandlers() {
  if (installed || (Platform.OS !== "android" && Platform.OS !== "ios")) return;
  installed = true;
  if (Platform.OS === "android") {
    TaskManager.defineTask<Notifications.NotificationTaskPayload>(TASK, async ({ data, error }) => {
      if (!error && data && "actionIdentifier" in data) await handle(data);
    });
  }
  Notifications.addNotificationResponseReceivedListener((response) => { void handle(response); });
}

export async function setupNotificationActions(): Promise<boolean> {
  if (Platform.OS !== "android" && Platform.OS !== "ios") return false;
  if (!setup) {
    setup = (async () => {
      installNotificationActionHandlers();
      // Serialize updates so concurrent writes cannot lose registered categories.
      for (const category of notificationCategories) {
        await Notifications.setNotificationCategoryAsync(category.identifier, category.actions);
      }
      if (Platform.OS === "android") await Notifications.registerTaskAsync(TASK);
      return true;
    })().catch(() => { setup = null; return false; });
  }
  return setup;
}
