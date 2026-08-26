import React, { useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { Preview } from "@storybook/react-native";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  ApiProvider,
  useAddressed,
  useMessageDrafts,
  useLive,
  useTldrView,
} from "@agora/core";
import {
  fixtureAgents,
  fixtureMe,
  fixtureUsers,
} from "@agora/core/testing/fixtures";
import {
  FixtureApiClient,
  type FixtureRoutes,
} from "@agora/core/testing/FixtureApiClient";
import { colors } from "../src/lib/theme";
import { useSession } from "../src/state/session";
import { usePrefs } from "../src/state/prefs";
import { useToasts } from "../src/components/Toast";

const session = { baseUrl: "https://storybook.invalid", token: "storybook" };
const defaultRoutes: FixtureRoutes = {
  "GET /api/me": fixtureMe,
  "GET /api/agents": { agents: fixtureAgents },
  "GET /api/users": { users: fixtureUsers },
};

function Providers({ routes, children }: { routes?: FixtureRoutes; children: ReactNode }) {
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
  const [api] = useState(() => new FixtureApiClient({ ...defaultRoutes, ...routes }));
  return (
    <QueryClientProvider client={queryClient}>
      <ApiProvider client={api}>
        {fixtureError ? (
          <View style={{ backgroundColor: "#7f1d1d", paddingVertical: 10, paddingHorizontal: 14 }}>
            <Text accessibilityRole="alert" style={{ color: "white", fontFamily: "monospace" }}>
              {fixtureError}
            </Text>
          </View>
        ) : null}
        {children}
      </ApiProvider>
    </QueryClientProvider>
  );
}

const preview: Preview = {
  beforeEach: (context) => {
    delete (globalThis as typeof globalThis & {
      __AGORA_STORY_PARAMS__?: Record<string, string>;
    }).__AGORA_STORY_PARAMS__;
    useLive.setState({ typing: {}, progress: {} });
    useTldrView.setState({ showing: {} });
    useAddressed.setState({ byConvo: {} });
    useMessageDrafts.setState({ byConvo: {} });
    usePrefs.setState({
      loaded: true,
      collapsedGroups: {},
      unreadsOnly: false,
      speakAloud: false,
      recentEmoji: [],
      preferNativeApps: true,
      linkBrowser: "in-app",
      threadSort: "recent",
      threadFilter: "all",
      requireAgentOffThreads: [],
    });
    useToasts.setState({ items: [] });
    useSession.setState({
      status: "signedIn",
      session,
      username: fixtureMe.username,
      displayName: fixtureMe.display_name,
      instanceAdmin: fixtureMe.instance_admin,
      instanceAdminKnown: true,
      voiceOk: fixtureMe.voice,
      savedUrl: session.baseUrl,
    });
    const setup = context.parameters.setup;
    if (typeof setup === "function") setup();
  },
  decorators: [
    (Story, context) => (
      <SafeAreaProvider>
        <Providers key={context.id} routes={context.parameters.apiRoutes as FixtureRoutes | undefined}>
          <View style={{ flex: 1, padding: 16, justifyContent: "center", backgroundColor: colors.bg }}>
            <Story />
          </View>
        </Providers>
      </SafeAreaProvider>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    options: {
      storySort: {
        order: ["Native", ["Foundations", "Atoms", "Messages", "Composer", "Overlays", "Screens"]],
      },
    },
  },
};

export default preview;
