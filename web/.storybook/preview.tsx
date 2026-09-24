import "./storage";
import { useState, type ReactNode } from "react";
import type { Preview } from "@storybook/react-vite";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { ApiProvider } from "@agora/core";
import {
  FixtureApiClient,
  type FixtureRoutes,
} from "@agora/core/testing/FixtureApiClient";
import { ToastHost } from "../src/lib/toast";
import { resetStoryState } from "../src/stories/resetState";
import "../src/styles.css";
import "./preview.css";

function StoryProviders({ routes, children }: {
  routes?: FixtureRoutes;
  children: ReactNode;
}) {
  const [fixtureError, setFixtureError] = useState("");
  const reportFixtureError = (error: Error) => {
    if (!error.message.startsWith("Missing Storybook fixture route:")) return;
    console.error(error);
    setFixtureError(error.message);
  };
  const [queryClient] = useState(() => new QueryClient({
    queryCache: new QueryCache({ onError: reportFixtureError }),
    mutationCache: new MutationCache({ onError: reportFixtureError }),
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  }));
  const [api] = useState(() => new FixtureApiClient(routes));
  return (
    <QueryClientProvider client={queryClient}>
      <ApiProvider client={api}>
        {fixtureError && (
          <div role="alert" style={{
            background: "#7f1d1d",
            color: "white",
            padding: "10px 14px",
            fontFamily: "monospace",
          }}>
            {fixtureError}
          </div>
        )}
        {children}
        <ToastHost />
      </ApiProvider>
    </QueryClientProvider>
  );
}

const preview: Preview = {
  beforeEach: (context) => {
    resetStoryState();
    const setup = context.parameters.setup;
    if (typeof setup === "function") setup();
  },
  decorators: [
    (Story, context) => {
      return (
        <StoryProviders key={context.id} routes={context.parameters.apiRoutes}>
          <main style={{ minHeight: "100vh" }}>
            <Story />
          </main>
        </StoryProviders>
      );
    },
  ],
  parameters: {
    a11y: {
      // Informational during the initial catalog rollout.
      test: "todo",
    },
    controls: { expanded: true },
    viewport: {
      options: {
        desktop: { name: "Desktop", styles: { width: "1440px", height: "900px" } },
        desktopBoundary: { name: "Desktop boundary", styles: { width: "1101px", height: "800px" } },
        tablet: { name: "Tablet overlay", styles: { width: "1000px", height: "1180px" } },
        tabletLowerBoundary: { name: "Tablet lower boundary", styles: { width: "821px", height: "900px" } },
        phoneUpperBoundary: { name: "Phone upper boundary", styles: { width: "820px", height: "900px" } },
        tabletComposer: { name: "Composer tablet", styles: { width: "768px", height: "900px" } },
        desktopComposer: { name: "Composer desktop", styles: { width: "1280px", height: "900px" } },
        phone: { name: "Phone", styles: { width: "390px", height: "844px" } },
        recordingPhone: { name: "Recording phone", styles: { width: "360px", height: "800px" } },
        smallPhone: { name: "Small phone", styles: { width: "320px", height: "568px" } },
      },
    },
  },
};

export default preview;
