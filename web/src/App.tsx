/* Root: session → ApiProvider → authed layout (topbar + agora panes).
   The auth gate shows when there is no token or /api/me rejects it. */

import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiClient, ApiProvider, DraftSyncGate, draftAuthRejected, draftIdentityChanged, draftSync, resetSeenMessageIds, useAddressed, useAttachmentDrafts, useMe, type DraftIdentity } from "@agora/core";
import { sessionToken, clearJoinToken } from "./lib/auth";
import { AuthGate } from "./components/AuthGate";
import { Topbar } from "./components/Topbar";
import { AgoraLayout } from "./components/AgoraLayout";
import { ToastHost } from "./lib/toast";

function AuthedApp({ onAuthFailed, onIdentity }: { onAuthFailed: (error: unknown) => void; onIdentity: (username: string) => void }) {
  const me = useMe();
  const failed = me.isError || (!me.isLoading && !me.data);
  useEffect(() => {
    if (failed) onAuthFailed(me.error);
    else if (me.data) { onIdentity(me.data.username); clearJoinToken(); }
  }, [failed, me.data, me.error, onAuthFailed, onIdentity]);
  if (me.isLoading || failed) return null;
  return (
    <>
      <main>
        <Topbar />
        <AgoraLayout />
      </main>
      <ToastHost />
    </>
  );
}

export function App() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const compact = window.matchMedia("(max-width: 820px)");
    const update = () => {
      // Mobile keyboards shrink the visual viewport, not necessarily 100dvh.
      // Do not reflow the chat when the user is pinch-zooming.
      if (compact.matches && Math.abs(viewport.scale - 1) < .01) {
        document.documentElement.style.setProperty("--ago-visible-height", `${viewport.height}px`);
      } else if (!compact.matches) {
        document.documentElement.style.removeProperty("--ago-visible-height");
      }
    };
    update();
    viewport.addEventListener("resize", update);
    compact.addEventListener("change", update);
    return () => {
      viewport.removeEventListener("resize", update);
      compact.removeEventListener("change", update);
      document.documentElement.style.removeProperty("--ago-visible-height");
    };
  }, []);
  const [token, setToken] = useState(sessionToken());
  const [gateVisible, setGateVisible] = useState(!token);
  const draftIdentity = useRef<DraftIdentity | null>(null);
  const qc = useQueryClient();
  useEffect(() => {
    const flush = () => draftSync.flushAll();
    const hidden = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => { window.removeEventListener("pagehide", flush); document.removeEventListener("visibilitychange", hidden); };
  }, []);

  const client = useMemo(
    () => new ApiClient({ baseUrl: "", token }),
    [token],
  );

  const signedIn = (username: string) => {
    const next = { server: window.location.origin, username };
    if (draftIdentityChanged(draftIdentity.current, next)) {
      draftSync.resetAll();
      useAddressed.getState().resetAll();
    }
    draftIdentity.current = next;
    resetSeenMessageIds(qc);
    qc.clear();
    useAttachmentDrafts.getState().reset();
    setToken(sessionToken());
    setGateVisible(false);
  };

  if (gateVisible || !token) {
    return (
      <>
        <AuthGate onSignedIn={signedIn} />
        <ToastHost />
      </>
    );
  }
  return (
    <ApiProvider client={client}>
      <DraftSyncGate />
      <AuthedApp onIdentity={username => { draftIdentity.current = { server: window.location.origin, username }; }} onAuthFailed={error => {
        useAttachmentDrafts.getState().reset();
        if (draftAuthRejected(error)) {
          draftSync.resetAll();
          useAddressed.getState().resetAll();
        }
        setGateVisible(true);
      }} />
    </ApiProvider>
  );
}
