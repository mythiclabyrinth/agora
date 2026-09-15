/* Root: session → ApiProvider → authed layout (topbar + agora panes).
   The auth gate shows when there is no token or /api/me rejects it. */

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiClient, ApiProvider, resetSeenMessageIds, useAttachmentDrafts, useMe } from "@agora/core";
import { sessionToken, clearJoinToken } from "./lib/auth";
import { AuthGate } from "./components/AuthGate";
import { Topbar } from "./components/Topbar";
import { AgoraLayout } from "./components/AgoraLayout";
import { ToastHost } from "./lib/toast";

function AuthedApp({ onAuthFailed }: { onAuthFailed: () => void }) {
  const me = useMe();
  const failed = me.isError || (!me.isLoading && !me.data);
  useEffect(() => {
    if (failed) onAuthFailed();
    else if (me.data) clearJoinToken();
  }, [failed, me.data, onAuthFailed]);
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
  const qc = useQueryClient();

  const client = useMemo(
    () => new ApiClient({ baseUrl: "", token }),
    [token],
  );

  const signedIn = () => {
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
      <AuthedApp onAuthFailed={() => {
        useAttachmentDrafts.getState().reset();
        setGateVisible(true);
      }} />
    </ApiProvider>
  );
}
