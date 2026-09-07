/* Live event socket: shared lifecycle from @agora/core, driven by RN
   AppState. On every (re)open we refetch active queries to heal any gap,
   and foregrounding forces a fresh connect when the socket isn't OPEN. */

import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import {
  applyWsEvent,
  createAgoraSocket,
  resetSeenMessageIds,
  wsUrl,
  type Message,
  type Session,
} from "@agora/core";
import { dismissResolvedNotification } from "../lib/notifications";

export function useAgoraSocket(
  session: Session,
  username: string,
  onAgentMessage?: (message: Message) => void,
) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const onAgentMessageRef = useRef(onAgentMessage);
  onAgentMessageRef.current = onAgentMessage;

  useEffect(() => {
    // Ids are per-instance rowids; drop the seen-set when baseUrl/token
    // changes so a server switch can't silently swallow real frames.
    resetSeenMessageIds(qc);
    const sock = createAgoraSocket(
      { url: () => wsUrl(session) },
      {
        onEvent: (ev) => {
          if (ev.type === "message_update") void dismissResolvedNotification(ev.message as Message);
          applyWsEvent(qc, ev, {
            username,
            onAgentMessage: (m) => onAgentMessageRef.current?.(m),
          });
        },
        onConnectedChange: setConnected,
        onReopen: () => {
          // Same-server restore can restart SQLite rowids while baseUrl/token
          // stay put — clear the seen-set so real frames aren't swallowed.
          resetSeenMessageIds(qc);
          void qc.refetchQueries({ type: "active" });
        },
      },
    );
    sock.connect();

    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") sock.wake();
    });

    return () => {
      sub.remove();
      sock.close();
    };
  }, [qc, session.baseUrl, session.token, username]);

  return connected;
}
