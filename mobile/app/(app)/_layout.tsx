/* Signed-in shell: guards the group, keeps the live socket mounted for the
   whole session, registers Expo push (with unread-poll fallback), and wires
   notification-tap routing plus the unread app badge. */

import React, { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { AppState } from "react-native";
import { Redirect, Stack, router, type Href, usePathname } from "expo-router";
import * as Notifications from "expo-notifications";
import { ApiClient, ApiProvider, DraftSyncGate, draftSync, useMe } from "@agora/core";
import { useSession } from "../../src/state/session";
import { useAgoraSocket } from "../../src/ws/useAgoraSocket";
import { emitAgentMessage } from "../../src/lib/agentBus";
import {
  notifyAgentMessage,
  reconcileNotifications,
  registerPushToken,
  setBadge,
  setupNotifications,
} from "../../src/lib/notifications";
import {
  registerBackgroundPolling,
  saveUnreadSnapshot,
  unregisterBackgroundPolling,
} from "../../src/lib/background";
import {
  notificationContext,
  notificationMessageId,
  notificationTarget,
  totalThreadUnread,
  totalUnread,
} from "@agora/core";
import { currentStoredSession, readActionRegistration } from "../../src/lib/notificationRegistration";
import { useGroups, useThreads } from "@agora/core";
import { headerBack } from "../../src/lib/headerItems";
import {
  notificationHref,
  notificationLandParams,
  notificationNavigationAction,
} from "../../src/lib/notificationRouting";

import { useAppTheme } from "../../src/lib/useTheme";
import { StoreReviewHost } from "../../src/components/StoreReviewHost";

/** Ensure cold-start deep links still have Home beneath them in the stack. */
export const unstable_settings = { initialRouteName: "index" };

function LiveSocket() {
  const session = useSession((s) => s.session)!;
  const username = useSession((s) => s.username);
  useAgoraSocket(session, username, (m) => {
    emitAgentMessage(m); // speak-aloud / live voice subscribers
    notifyAgentMessage(m);
  });
  return null;
}

function DraftBackgroundFlush() {
  useEffect(() => {
    const sub = AppState.addEventListener("change", state => {
      if (state !== "active") draftSync.flushAll();
    });
    return () => sub.remove();
  }, []);
  return null;
}

/** Badge = channel unreads + thread unreads; snapshot feeds the poll
    fallback's diff so messages read here don't come back as stale banners. */
function UnreadSync() {
  const session = useSession((s) => s.session);
  const groups = useGroups().data;
  const threads = useThreads().data;
  useEffect(() => {
    if (!groups) return;
    setBadge(totalUnread(groups) + totalThreadUnread(threads ?? []));
    saveUnreadSnapshot(groups);
    void reconcileNotifications(groups, threads ?? [], session ?? undefined);
  }, [groups, threads, session]);
  return null;
}

/** The latest notification response: the launching one, then every tap.
    Expo's useLastNotificationResponse drops a response whose identifier
    matches the previous one, and cards for one conversation share an
    identifier, so every tap after the first would be swallowed. */
function useNotificationResponse() {
  const [response, setResponse] = useState<Notifications.NotificationResponse | null>(null);
  useLayoutEffect(() => {
    setResponse(Notifications.getLastNotificationResponse());
    const subscription = Notifications.addNotificationResponseReceivedListener(setResponse);
    // A cleared response is no longer one to act on, as with Expo's hook.
    const cleared = Notifications.addNotificationResponseClearedListener(() => setResponse(null));
    return () => {
      subscription.remove();
      cleared.remove();
    };
  }, []);
  return response;
}

/* The tap last routed. Module-level, not a ref: signing out and back in
   remounts the router, and the last response it reads again on mount is a
   tap already handled, which must not navigate a second time. */
let handledTap: string | null = null;

/** Forgets the tap last routed; for tests, which share this module. */
export function resetHandledNotificationTap() {
  handledTap = null;
}

/** Tapping a banner lands on its message in the channel (or thread). Covers
    warm taps and cold starts alike via the last-response hook. */
export function NotificationTapRouter() {
  const response = useNotificationResponse();
  const pathname = usePathname();
  useEffect(() => {
    if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const id = response.notification.request.identifier;
    const data = response.notification.request.content.data;
    // Cards for one conversation reuse its identifier, so a later card's tap
    // is a different response with the same id; its message and delivery
    // date tell them apart (dates can be coarse on some platforms).
    // URL-safe: it doubles as the landAt route param (no '#').
    const tap = `${id}~${notificationMessageId(data) ?? ""}@${response.notification.date}`;
    if (handledTap === tap) return;
    const target = notificationTarget(data);
    if (!target) return;
    // The tapped card normally auto-dismisses; make that deterministic. Other
    // cards wait for the read marker so a newer racing message is preserved.
    const navigate = () => {
      if (handledTap === tap) return;
      handledTap = tap;
      void Notifications.dismissNotificationAsync(id);
      const messageId = notificationMessageId(data);
      const action = notificationNavigationAction({ pathname, target, messageId });
      if (action === "push") router.push(notificationHref(target, messageId) as Href);
      // Already in that conversation: re-target the screen on top in place.
      // The tap key rides along so a repeat tap for the same message re-lands.
      else if (action === "land" && messageId != null) {
        router.setParams(notificationLandParams(messageId, tap));
      }
    };
    const context = notificationContext(data);
    if (!context) { navigate(); return; }
    let cancelled = false;
    void Promise.all([readActionRegistration(), currentStoredSession()]).then(([registration, session]) => {
      // Missing/unavailable local bindings must not strand a body tap. Only a
      // known foreign binding prevents navigation; actions remain stricter.
      if (!cancelled && (!registration ||
          (registration.context === context && registration.baseUrl === session?.baseUrl))) navigate();
    }).catch(() => { if (!cancelled) navigate(); });
    return () => { cancelled = true; };
  }, [pathname, response]);
  return null;
}

export default function AppLayout() {
  const { colors } = useAppTheme();
  const pathname = usePathname();
  const status = useSession((s) => s.status);
  const session = useSession((s) => s.session);
  useEffect(() => {
    void setupNotifications();
  }, []);
  useEffect(() => {
    if (status !== "signedIn" || !session) return;
    let cancelled = false;
    void (async () => {
      const pushOk = await registerPushToken(session);
      if (cancelled) return;
      if (pushOk) {
        await unregisterBackgroundPolling();
      } else {
        await registerBackgroundPolling();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, session]);

  if (status === "loading") return null;
  if (status !== "signedIn" || !session) {
    return <Redirect href={{ pathname: "/connect", params: { next: pathname } }} />;
  }

  return (
    <ApiWrapped session={session}>
      <LiveSocket />
      <DraftBackgroundFlush />
      <UnreadSync />
      <NotificationTapRouter />
      <StoreReviewHost />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerTitleStyle: { fontWeight: "700" },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.bg },
          ...headerBack(),
        }}
      />
    </ApiWrapped>
  );
}

/* One memoized ApiClient per session, provided via @agora/core's context —
   every query hook under the signed-in shell reads it with useApi(). */
function ApiWrapped({ session, children }: {
  session: { baseUrl: string; token: string };
  children: React.ReactNode;
}) {
  const client = useMemo(
    () => new ApiClient(session),
    [session.baseUrl, session.token], // eslint-disable-line react-hooks/exhaustive-deps
  );
  return <ApiProvider client={client}><DraftIdentityGate server={session.baseUrl} /><DraftSyncGate />{children}</ApiProvider>;
}

function DraftIdentityGate({ server }: { server: string }) {
  const username = useMe().data?.username;
  useEffect(() => {
    if (username) useSession.getState().rememberDraftIdentity(server, username);
  }, [server, username]);
  return null;
}
