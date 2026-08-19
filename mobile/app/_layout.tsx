import React, { useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { Stack } from "expo-router";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, resetSeenMessageIds } from "@agora/core";
import { onUnauthorized, useSession } from "../src/state/session";
import { ToastHost } from "../src/components/Toast";
import { colors } from "../src/lib/theme";
// Side-effect import: defines the background unread task at module scope so
// it exists when iOS launches the app headless to run it.
import "../src/lib/background";

function handleAuthError(error: unknown) {
  // A revoked/rotated admin key drops the app back to the connect screen.
  if (error instanceof ApiError && error.status === 401) onUnauthorized();
}

export default function RootLayout() {
  const [client] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({ onError: handleAuthError }),
        mutationCache: new MutationCache({ onError: handleAuthError }),
        defaultOptions: {
          queries: { staleTime: 30_000, retry: 1 },
        },
      }),
  );
  const load = useSession((s) => s.load);
  const status = useSession((s) => s.status);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    // Query keys are intentionally server-resource scoped, not credential
    // scoped. Purge private data before another account can reuse the client.
    // clear() does not touch the WS seen-id WeakMap — reset that too.
    if (status === "signedOut") {
      resetSeenMessageIds(client);
      client.clear();
    }
  }, [client, status]);

  return (
    <QueryClientProvider client={client}>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      />
      <ToastHost />
    </QueryClientProvider>
  );
}
