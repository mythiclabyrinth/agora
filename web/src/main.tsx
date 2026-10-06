import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initToken } from "./lib/auth";
import { App } from "./App";
import "./styles.css";
import { syncAppearance } from "./state/appearance";
import { installTruncationTooltips } from "./lib/truncationTooltips";
import { resetInboxTabOnReload } from "./lib/inboxReload";

const stopAppearanceSync = syncAppearance();
const stopTruncationTooltips = installTruncationTooltips();
if (import.meta.hot) import.meta.hot.dispose(() => { stopAppearanceSync(); stopTruncationTooltips(); });

// Consume ?token= and the auth fragments before anything renders or fetches.
initToken();
resetInboxTabOnReload();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
