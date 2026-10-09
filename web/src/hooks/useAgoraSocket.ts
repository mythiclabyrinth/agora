/* Live event socket — shared lifecycle from @agora/core. Browser twist:
   visibilitychange/online listeners force an immediate reconnect when the
   tab wakes (the RN AppState equivalent). */

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  applyWsEvent,
  draftSync,
  chimeAllowed,
  createAgoraSocket,
  initialChimeState,
  resetSeenMessageIds,
  shouldChime,
  type Message,
} from "@agora/core";
import { sessionToken } from "../lib/auth";
import { armChime, isDesktopShell, playChime } from "../lib/chime";
import { useUiState } from "../state/ui";

export function useAgoraSocket(username: string, onAgentMessage?: (m: Message) => void) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const onAgentMessageRef = useRef(onAgentMessage);
  onAgentMessageRef.current = onAgentMessage;

  useEffect(() => {
    if (!username) return;
    resetSeenMessageIds(qc);
    const desktop = isDesktopShell();
    const disarmChime = armChime();
    let chimeState = initialChimeState();

    const url = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      return `${proto}//${location.host}/ws?token=${encodeURIComponent(sessionToken())}`;
    };

    const sock = createAgoraSocket(
      { url },
      {
        onEvent: (ev) =>
          applyWsEvent(qc, ev, {
            username,
            onAgentMessage: (m) => onAgentMessageRef.current?.(m),
            onMessage: (message) => {
              if (!chimeAllowed({ desktop, focused: document.hasFocus(), enabled: useUiState.getState().soundEnabled })) return;
              const decision = shouldChime(chimeState, message, username, Date.now());
              chimeState = decision.state;
              if (decision.play) playChime(useUiState.getState().soundVolume);
            },
          }),
        onConnectedChange: setConnected,
        onReopen: () => {
          // Same-server restore can restart SQLite rowids while the session
          // stays put — clear the seen-set so real frames aren't swallowed.
          resetSeenMessageIds(qc);
          void qc.refetchQueries({ type: "active" });
          draftSync.flushAll();
          void draftSync.hydrate().catch(() => {});
        },
      },
    );
    sock.connect();

    const wake = () => sock.wake();
    const onVis = () => {
      if (document.visibilityState === "visible") { wake(); draftSync.flushAll(); void draftSync.hydrate().catch(() => {}); }
    };
    document.addEventListener("visibilitychange", onVis);
    const onOnline = () => { wake(); draftSync.flushAll(); void draftSync.hydrate().catch(() => {}); };
    window.addEventListener("online", onOnline);

    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", onOnline);
      disarmChime();
      sock.close();
    };
  }, [qc, username]);

  return connected;
}
