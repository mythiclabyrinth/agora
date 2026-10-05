/* Live event socket — shared lifecycle from @agora/core. Browser twist:
   visibilitychange/online listeners force an immediate reconnect when the
   tab wakes (the RN AppState equivalent). */

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  applyWsEvent,
  createAgoraSocket,
  initialChimeState,
  resetSeenMessageIds,
  shouldChime,
  type Message,
} from "@agora/core";
import { sessionToken } from "../lib/auth";
import { armDesktopChime, isDesktopShell, playDesktopChime } from "../lib/desktopChime";
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
    const disarmChime = desktop ? armDesktopChime() : () => {};
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
            onMessage: desktop ? (message) => {
              if (!document.hasFocus() || !useUiState.getState().soundEnabled) return;
              const decision = shouldChime(chimeState, message, username, Date.now());
              chimeState = decision.state;
              if (decision.play) playDesktopChime();
            } : undefined,
          }),
        onConnectedChange: setConnected,
        onReopen: () => {
          // Same-server restore can restart SQLite rowids while the session
          // stays put — clear the seen-set so real frames aren't swallowed.
          resetSeenMessageIds(qc);
          void qc.refetchQueries({ type: "active" });
        },
      },
    );
    sock.connect();

    const wake = () => sock.wake();
    const onVis = () => {
      if (document.visibilityState === "visible") wake();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", wake);

    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", wake);
      disarmChime();
      sock.close();
    };
  }, [qc, username]);

  return connected;
}
