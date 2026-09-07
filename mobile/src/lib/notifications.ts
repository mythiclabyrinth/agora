/* Notifications: remote Expo push while suspended (APNs/FCM), plus local
   banners as a fallback when no push token is registered (simulator / denied
   permission / Expo Go). Nothing fires while the app is active and visible,
   mirroring the desktop's unfocused-only rule. */

import { AppState, Platform } from "react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { ApiClient, type Session } from "@agora/core";
import type { Message } from "@agora/core";
import type { ChannelUnread } from "@agora/core";
import type { Group, ThreadRow } from "@agora/core";
import {
  conversationKey,
  obsoleteNotificationIds,
} from "./notificationCleanup";
import { notificationIsResolved, notificationIsPending, notificationContext, notificationMessageId, type Me } from "@agora/core";
import { setupNotificationActions } from "./notificationActionRuntime";
import { readActionRegistration, registrationEpoch, saveActionRegistration } from "./notificationRegistration";

const KEY_PUSH_TOKEN = "agora_push_token";

let ready = false;
/** Once we have a server-registered Expo token, WS-path local banners would
    double up with remote push — suppress them. */
let pushActive = false;

function easProjectId(): string | undefined {
  return Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
}

export async function setupNotifications(): Promise<void> {
  if (ready) return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: AppState.currentState !== "active",
      shouldShowList: AppState.currentState !== "active",
      shouldPlaySound: false,
      shouldSetBadge: false, // the badge tracks unread counts, not banners
    }),
  });
  try {
    await Notifications.requestPermissionsAsync();
  } catch {
    /* denied — notify() calls become no-ops at the OS level */
  }
  ready = true;
}

/** Obtain an Expo push token and register it with the server. Returns true
    when remote push is live (caller can drop the background unread poll). */
export async function registerPushToken(session: Session): Promise<boolean> {
  const started = registrationEpoch();
  await setupNotifications();
  const projectId = easProjectId();
  if (!projectId) return false;
  let token: string;
  try {
    const result = await Notifications.getExpoPushTokenAsync({ projectId });
    token = result.data;
  } catch {
    return false; // simulator / missing entitlement / Expo Go
  }
  try {
    const api = new ApiClient(session);
    const actionSupport = await setupNotificationActions();
    const previous = actionSupport ? await readActionRegistration() : null;
    const registered = await api.post<{ notification_action_context?: string }>("/api/push-tokens", {
      token,
      platform: Platform.OS,
      ...(actionSupport ? {
        notification_action_version: 1,
        notification_action_context: previous?.baseUrl === session.baseUrl ? previous.context : undefined,
      } : {}),
    });
    if (actionSupport && registered.notification_action_context) {
      const me = await api.get<Me>("/api/me");
      const saved = await saveActionRegistration({
        baseUrl: session.baseUrl, username: me.username, context: registered.notification_action_context,
      }, session, started);
      if (!saved) return false;
    }
    if (started !== registrationEpoch()) return false;
    await SecureStore.setItemAsync(KEY_PUSH_TOKEN, token);
    pushActive = true;
    return true;
  } catch {
    return false;
  }
}

/** Best-effort revoke on sign-out so the server stops waking this device. */
export async function unregisterPushToken(session: Session | null): Promise<void> {
  const token = await SecureStore.getItemAsync(KEY_PUSH_TOKEN);
  pushActive = false;
  await Promise.allSettled([
    Notifications.dismissAllNotificationsAsync(),
    Notifications.setBadgeCountAsync(0),
  ]);
  if (token) {
    await SecureStore.deleteItemAsync(KEY_PUSH_TOKEN).catch(() => {});
  }
  if (!session || !token) return;
  try {
    const api = new ApiClient(session);
    await api.delete("/api/push-tokens", { token });
  } catch {
    /* offline / already rotated — local clear is enough */
  }
}

export function notifyAgentMessage(message: Message): void {
  if (pushActive) return; // remote push covers suspended + backgrounded
  if (AppState.currentState === "active") return;
  const title = message.author_name || message.author_id;
  const body =
    message.text.length > 140 ? `${message.text.slice(0, 140)}…` : message.text || "(attachment)";
  void Notifications.scheduleNotificationAsync({
    identifier: conversationKey(message.channel_id, message.thread_id),
    content: {
      title,
      body,
      // Tap routing (see notificationTarget in unread.ts).
      data: {
        channel_id: message.channel_id,
        thread_id: message.thread_id,
        message_id: message.id,
      },
    },
    trigger: null, // now
  });
}

/** One catch-up banner per channel with new activity, from the poller.
    Mentions lead the copy so "someone @'d you" isn't buried in traffic. */
export function notifyUnreadChannel(
  channel: ChannelUnread,
  newCount: number,
  newMentions = 0,
): void {
  const body =
    newMentions > 0
      ? newMentions === 1
        ? "You were mentioned"
        : `${newMentions} mentions`
      : newCount === 1
        ? "1 new message"
        : `${newCount} new messages`;
  void Notifications.scheduleNotificationAsync({
    identifier: conversationKey(channel.id),
    content: {
      title: `${channel.group} / #${channel.name}`,
      body,
      data: { channel_id: channel.id },
    },
    trigger: null,
  });
}

export async function dismissResolvedNotification(message: Message): Promise<void> {
  const meta = message.meta;
  // Row-only tables also finish through row resolutions, not table submission.
  if (!meta?.resolved && !meta?.form_submitted && !meta?.table_submitted &&
      !Object.keys(meta?.table_rows ?? {}).length) return;
  try {
    const started = registrationEpoch();
    const registration = await readActionRegistration();
    const presented = await Notifications.getPresentedNotificationsAsync();
    if (started !== registrationEpoch()) return;
    await Promise.all(presented.filter((n) => {
      const context = notificationContext(n.request.content.data);
      return (!context || context === registration?.context) && notificationIsResolved(n.request.content.data, message);
    })
      .map((n) => Notifications.dismissNotificationAsync(n.request.identifier)));
  } catch { /* best effort while the process is alive */ }
}

type Reconciliation = { groups: Group[]; threads: ThreadRow[]; session?: Session };
let queuedReconciliation: Reconciliation | null = null;
let reconciliation: Promise<void> | null = null;
let lastPendingCheck: { key: string; token: string; until: number } | null = null;

export function reconcileNotifications(groups: Group[], threads: ThreadRow[], session?: Session): Promise<void> {
  queuedReconciliation = { groups, threads, session };
  if (!reconciliation) {
    reconciliation = (async () => {
      while (queuedReconciliation) {
        const next = queuedReconciliation;
        queuedReconciliation = null;
        await reconcileNotificationBatch(next.groups, next.threads, next.session);
      }
    })().finally(() => { reconciliation = null; });
  }
  return reconciliation;
}

async function reconcileNotificationBatch(groups: Group[], threads: ThreadRow[], session?: Session): Promise<void> {
  try {
    const started = registrationEpoch();
    const registration = await readActionRegistration();
    const presented = await Notifications.getPresentedNotificationsAsync();
    if (started !== registrationEpoch()) return;
    const obsolete = obsoleteNotificationIds(
      presented.map((notification) => ({
        identifier: notification.request.identifier,
        data: notification.request.content.data,
      })),
      groups,
      threads,
    );
    await Promise.all(obsolete.map((identifier) =>
      Notifications.dismissNotificationAsync(identifier)));
    if (session) {
      // Notification Center can contain older messages outside every loaded
      // query page. Reconcile those against the authenticated message endpoint.
      const pending = presented.filter((notification) => notificationIsPending(notification.request.content.data) &&
        notificationMessageId(notification.request.content.data) !== null);
      const key = JSON.stringify([started, session.baseUrl, registration?.context,
        pending.map(({ request }) => [request.identifier, notificationMessageId(request.content.data),
          notificationContext(request.content.data)]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
      if (!pending.length) { lastPendingCheck = null; return; }
      if (lastPendingCheck?.key === key && lastPendingCheck.token === session.token &&
          Date.now() < lastPendingCheck.until) return;
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timeout = setTimeout(() => { controller.abort(); resolve(); }, 8000);
      });
      const checks = pending.map(async (notification) => {
        const data = notification.request.content.data;
        const messageId = notificationMessageId(data);
        const context = notificationContext(data);
        try {
          if (started !== registrationEpoch() || controller.signal.aborted) return;
          if (context && context !== registration?.context) {
            await Notifications.dismissNotificationAsync(notification.request.identifier);
            return;
          }
          const response = await fetch(`${session.baseUrl}/api/messages/${messageId}`, {
            headers: { Authorization: `Bearer ${session.token}` }, signal: controller.signal, redirect: "error",
          });
          const resolved = response.status === 403 || response.status === 404 ||
            (response.ok && notificationIsResolved(data, await response.json() as Message));
          if (started !== registrationEpoch() || controller.signal.aborted) return;
          if (resolved) {
            await Notifications.dismissNotificationAsync(notification.request.identifier);
          }
        } catch { /* offline: retain the pending request */ }
      });
      try {
        // One deadline for the whole set, including body decoding. Late results
        // cannot mutate cards after timeout or account changes.
        await Promise.race([Promise.all(checks), deadline]);
      } finally {
        clearTimeout(timeout);
        controller.abort();
        lastPendingCheck = { key, token: session.token, until: Date.now() + 5000 };
      }
    }
  } catch {
    /* Notification Center access is best-effort. */
  }
}

/** App-icon badge = total unread; reads (anywhere) bring it back down. */
export function setBadge(total: number): void {
  Notifications.setBadgeCountAsync(total).catch(() => {
    /* simulators without badge support */
  });
}
