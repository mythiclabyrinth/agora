/* Signed-in shell: guards the group, keeps the live socket mounted for the
   whole session, registers Expo push (with unread-poll fallback), and wires
   notification-tap routing plus the unread app badge. */

import React, { useEffect, useMemo, useRef } from "react";
import { Redirect, Stack, router, type Href, usePathname } from "expo-router";
import * as Notifications from "expo-notifications";
import { ApiClient, ApiProvider } from "@agora/core";
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
import { notificationTarget, totalThreadUnread, totalUnread } from "@agora/core";
import { useGroups, useThreads } from "@agora/core";
import { headerBack } from "../../src/lib/headerItems";
import { notificationNavigationAction } from "../../src/lib/notificationRouting";
import { colors } from "../../src/lib/theme";
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

/** Badge = channel unreads + thread unreads; snapshot feeds the poll
    fallback's diff so messages read here don't come back as stale banners. */
function UnreadSync() {
  const groups = useGroups().data;
  const threads = useThreads().data;
  useEffect(() => {
    if (!groups) return;
    setBadge(totalUnread(groups) + totalThreadUnread(threads ?? []));
    saveUnreadSnapshot(groups);
    void reconcileNotifications(groups, threads ?? []);
  }, [groups, threads]);
  return null;
}

/** Tapping a banner lands in its channel (or thread). Covers warm taps and
    cold starts alike via the last-response hook. */
export function NotificationTapRouter() {
  const response = Notifications.useLastNotificationResponse();
  const pathname = usePathname();
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!response) return;
    const id = response.notification.request.identifier;
    if (handled.current === id) return;
    handled.current = id;
    const target = notificationTarget(response.notification.request.content.data);
    if (!target) return;
    // The tapped card normally auto-dismisses; make that deterministic. Other
    // cards wait for the read marker so a newer racing message is preserved.
    void Notifications.dismissNotificationAsync(id);

    const action = notificationNavigationAction({ pathname, target });
    if (action === "none") return;
    router.push(target as Href);
  }, [pathname, response]);
  return null;
}

export default function AppLayout() {
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
  return <ApiProvider client={client}>{children}</ApiProvider>;
}
