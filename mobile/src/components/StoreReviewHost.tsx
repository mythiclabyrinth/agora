/* App-level store-review host: loads counters, watches agent replies that
   follow the current user's messages, and flushes a deferred prompt on
   navigation or return-to-foreground — never mid-read or mid-call. */

import React, { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { usePathname } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { onAgentMessage } from "../lib/agentBus";
import {
  agentReplyFollowsUserInCache,
  flushDeferredReviewPrompt,
  initStoreReview,
  recordPositiveEvent,
  setReviewVoiceActive,
} from "../lib/storeReview";
import { useSession } from "../state/session";

export function StoreReviewHost() {
  const qc = useQueryClient();
  const username = useSession((s) => s.username);
  const pathname = usePathname();
  const prevPath = useRef(pathname);

  useEffect(() => {
    void initStoreReview();
  }, []);

  useEffect(() => {
    setReviewVoiceActive(/\/live(?:\/|$)/.test(pathname));
  }, [pathname]);

  useEffect(() => {
    if (prevPath.current === pathname) return;
    prevPath.current = pathname;
    void flushDeferredReviewPrompt();
  }, [pathname]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void flushDeferredReviewPrompt();
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    return onAgentMessage((m) => {
      if (!agentReplyFollowsUserInCache(qc, m, username)) return;
      void recordPositiveEvent();
    });
  }, [qc, username]);

  return null;
}
