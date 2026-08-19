/* Live event socket — shared lifecycle from @agora/core. Browser twist:
   visibilitychange/online listeners force an immediate reconnect when the
   tab wakes (the RN AppState equivalent). */

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  applyWsEvent,
  createAgoraSocket,
  resetSeenMessageIds,
  type Message,
} from "@agora/core";
import { sessionToken } from "../lib/auth";

export function useAgoraSocket(username: string, onAgentMessage?: (m: Message) => void) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const onAgentMessageRef = useRef(onAgentMessage);
  onAgentMessageRef.current = onAgentMessage;

  useEffect(() => {
    if (!username) return;
    resetSeenMessageIds(qc);

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
          }),
        onConnectedChange: setConnected,
        onReopen: () => {
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
      sock.close();
    };
  }, [qc, username]);

  return connected;
}
