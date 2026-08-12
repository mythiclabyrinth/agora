import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Share, Text } from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as Clipboard from "expo-clipboard";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiClient, ApiProvider, keys } from "@agora/core";
import {
  AddAgentFlow,
  AgentConnectionsList,
} from "../src/components/AgentConnections";
import { useSession } from "../src/state/session";
import AddAgentScreen from "../app/(app)/add-agent";

jest.mock(
  "lucide-react-native",
  () =>
    new Proxy(
      {},
      {
        get: () =>
          function MockIcon() {
            return null;
          },
      },
    ),
);
jest.mock("expo-router", () => ({
  Stack: { Screen: () => null },
}));

class RecordingApi extends ApiClient {
  calls: Array<{ path: string; body: unknown }> = [];
  puts: Array<{ path: string; body: unknown }> = [];
  deletes: string[] = [];

  constructor(private readonly failGets = false) {
    super({ baseUrl: "https://agora.example", token: "test" });
  }

  override async post<T>(path: string, body?: unknown): Promise<T> {
    this.calls.push({ path, body });
    return { token: "issued-secret-token" } as T;
  }

  override async get<T>(path: string): Promise<T> {
    if (this.failGets) throw new Error("offline");
    if (path === "/api/connections") {
      return {
        connections: [
          {
            name: "Home",
            url: "wss://pantheo.example/agora/connect",
            enabled: false,
            status: null,
          },
          {
            name: "Office",
            url: "wss://offline.example/agora/connect",
            enabled: true,
            status: {
              connected: false,
              agents: [],
              last_error: "Connection refused",
            },
          },
        ],
      } as T;
    }
    if (path === "/api/pairing") {
      return {
        tokens: [
          {
            id: "pair-laptop",
            token: "codex-token",
            name: "Laptop",
            kind: "codex",
            created_at: 1,
          },
          {
            id: "pair-custom",
            token: "custom-token",
            name: "Custom integration",
            created_at: 2,
          },
        ],
      } as T;
    }
    if (path === "/api/admin/sources") return { sources: [
      { kind: "pantheo", id: "Home", name: "Home", agents: [{ id: "research", name: "Research", live: false, last_seen: 1 }] },
      { kind: "pairing", id: "pair-laptop", name: "Laptop", agents: [{ id: "codex", name: "Codex", live: true, last_seen: 1 }] },
      { kind: "pairing", id: "pair-custom", name: "Custom integration", agents: [] },
    ] } as T;
    if (path === "/api/admin/agents/codex/dm-policy") return { agent_id: "codex", is_public: false, grants: [] } as T;
    if (path === "/api/users") return { users: [{ username: "alice", display_name: "Alice", instance_role: "member", disabled: false }] } as T;
    throw new Error(`Unexpected GET ${path}`);
  }

  override async put<T>(path: string, body?: unknown): Promise<T> {
    this.puts.push({ path, body });
    return {} as T;
  }

  override async delete<T>(path: string): Promise<T> {
    this.deletes.push(path);
    return {} as T;
  }
}

function renderFlow(
  api: RecordingApi,
  element = React.createElement(AddAgentFlow),
  seedList: false | "data" | "error" = false,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  if (seedList === "data") {
    queryClient.setQueryData(keys.connections, [
      {
        name: "Home",
        url: "wss://pantheo.example/agora/connect",
        enabled: false,
        status: null,
      },
      {
        name: "Office",
        url: "wss://offline.example/agora/connect",
        enabled: true,
        status: {
          connected: false,
          agents: [],
          last_error: "Connection refused",
        },
      },
    ]);
    queryClient.setQueryData(keys.pairing, [
      {
        id: "pair-laptop",
        token: "codex-token",
        name: "Laptop",
        kind: "codex",
        created_at: 1,
      },
      {
        id: "pair-custom",
        token: "custom-token",
        name: "Custom integration",
        created_at: 2,
      },
    ]);
    queryClient.setQueryData(keys.agentSources, [
      { kind: "pantheo", id: "Home", name: "Home", agents: [{ id: "research", name: "Research", live: false, last_seen: 1 }] },
      { kind: "pairing", id: "pair-laptop", name: "Laptop", agents: [{ id: "codex", name: "Codex", live: true, last_seen: 1 }] },
      { kind: "pairing", id: "pair-custom", name: "Custom integration", agents: [] },
    ]);
    queryClient.setQueryData(keys.agentDmPolicy("codex"), { agent_id: "codex", is_public: false, grants: [] });
    queryClient.setQueryData(keys.users, [{ username: "alice", display_name: "Alice", instance_role: "member", disabled: false }]);
  } else if (seedList === "error") {
    for (const queryKey of [keys.connections, keys.pairing]) {
      const query = queryClient.getQueryCache().build(queryClient, {
        queryKey,
        queryFn: async () => {
          throw new Error("offline");
        },
      });
      query.setState({
        ...query.state,
        error: new Error("offline"),
        errorUpdatedAt: Date.now(),
        fetchStatus: "idle",
        status: "error",
      });
    }
  }
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(ApiProvider, { client: api }, element),
      ),
    );
  });
  return tree;
}

function labelled(root: TestRenderer.ReactTestInstance, label: string) {
  return root.find((node) => node.props.accessibilityLabel === label);
}

function pressText(root: TestRenderer.ReactTestInstance, text: string) {
  const label = root.findAllByProps({ children: text })[0];
  let current = label;
  while (current.parent && typeof current.props.onPress !== "function") {
    current = current.parent;
  }
  current.props.onPress();
}

beforeEach(() => {
  useSession.setState({
    status: "signedIn",
    session: { baseUrl: "https://agora.example/path", token: "test" },
    username: "admin",
    displayName: "Admin",
    instanceAdmin: true,
    instanceAdminKnown: true,
  });
});

test("catalog creates typed Codex access and renders the issued credential", async () => {
  const api = new RecordingApi();
  const tree = renderFlow(api);

  act(() => labelled(tree.root, "Connect a coding agent").props.onPress());
  act(() => labelled(tree.root, "Connect Codex CLI").props.onPress());
  const input = tree.root.findByProps({ placeholder: "Codex" });
  act(() => input.props.onChangeText("Work Codex"));
  await act(async () => pressText(tree.root, "Create access"));

  expect(api.calls).toEqual([
    {
      path: "/api/pairing",
      body: { name: "Work Codex", kind: "codex" },
    },
  ]);
  expect(JSON.stringify(tree.toJSON())).toContain("issued-secret-token");
  act(() => tree.unmount());
});

test("Another agent deliberately creates generic access without kind", async () => {
  const api = new RecordingApi();
  const tree = renderFlow(api);

  act(() =>
    labelled(tree.root, "Create access for another agent").props.onPress(),
  );
  const input = tree.root.findByProps({ placeholder: "Agent" });
  act(() => input.props.onChangeText("Future connector"));
  await act(async () => pressText(tree.root, "Create access"));

  expect(api.calls[0]).toEqual({
    path: "/api/pairing",
    body: { name: "Future connector", kind: undefined },
  });
  act(() => tree.unmount());
});

test("Pantheo link validates required fields and submits trimmed values", async () => {
  const api = new RecordingApi();
  const onDone = jest.fn();
  const tree = renderFlow(
    api,
    React.createElement(AddAgentFlow, { initialKind: "pantheo", onDone }),
  );

  act(() => pressText(tree.root, "Link instance"));
  expect(api.calls).toHaveLength(0);

  act(() =>
    tree.root
      .findByProps({ placeholder: "e.g. Home" })
      .props.onChangeText("  Office  "),
  );
  act(() =>
    tree.root
      .findByProps({ placeholder: "wss://pantheo.example/agora/connect" })
      .props.onChangeText("  wss://office.example/agora/connect  "),
  );
  act(() =>
    tree.root
      .findByProps({ placeholder: "PANTHEO_API_TOKEN" })
      .props.onChangeText("  secret  "),
  );
  await act(async () => pressText(tree.root, "Link instance"));

  expect(api.calls).toEqual([
    {
      path: "/api/connections",
      body: {
        name: "Office",
        url: "wss://office.example/agora/connect",
        token: "secret",
      },
    },
  ]);
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(
    tree.root.findByProps({ placeholder: "PANTHEO_API_TOKEN" }).props.value,
  ).toBe("");
  act(() => tree.unmount());
});

test("success state shows the supplied token and remote socket address", () => {
  const tree = renderFlow(
    new RecordingApi(),
    React.createElement(AddAgentFlow, {
      initialKind: "hermes",
      initialIssued: "one-time-token",
    }),
  );
  expect(JSON.stringify(tree.toJSON())).toContain("one-time-token");
  expect(JSON.stringify(tree.toJSON())).toContain(
    "wss://agora.example/agent/ws?token=one-time-token",
  );
  act(() => tree.unmount());
});

test("Hermes success links to its platform guide", async () => {
  const open = jest.spyOn(WebBrowser, "openBrowserAsync").mockResolvedValue({
    type: WebBrowser.WebBrowserResultType.OPENED,
  });
  const tree = renderFlow(
    new RecordingApi(),
    React.createElement(AddAgentFlow, {
      initialKind: "hermes",
      initialIssued: "hermes-token",
    }),
  );
  await act(async () => pressText(tree.root, "Open setup guide"));
  expect(open).toHaveBeenCalledWith(
    "https://agora.example/docs/agents/hermes.html",
  );
  open.mockRestore();
  act(() => tree.unmount());
});

test("local success opens the origin-hosted guide without a socket address", async () => {
  const open = jest.spyOn(WebBrowser, "openBrowserAsync").mockResolvedValue({
    type: WebBrowser.WebBrowserResultType.OPENED,
  });
  const tree = renderFlow(
    new RecordingApi(),
    React.createElement(AddAgentFlow, {
      initialKind: "codex",
      initialIssued: "local-token",
    }),
  );
  const rendered = JSON.stringify(tree.toJSON());
  expect(rendered).not.toContain("agent/ws");

  await act(async () => pressText(tree.root, "Open setup guide"));
  expect(open).toHaveBeenCalledWith(
    "https://agora.example/docs/coding-agents/codex.html",
  );
  open.mockRestore();
  act(() => tree.unmount());
});

test("connection list distinguishes disabled links and unknown agent kinds", async () => {
  const tree = renderFlow(
    new RecordingApi(),
    React.createElement(AgentConnectionsList),
    "data",
  );
  await act(async () => {});
  const rendered = JSON.stringify(tree.toJSON());

  expect(rendered).toContain("Home");
  expect(rendered).toContain("Disabled");
  expect(rendered).not.toContain("Connecting…");
  expect(rendered).toContain("Connection refused");
  expect(rendered).toContain("Codex");
  expect(
    tree.root.findAll(
      (node) => node.type === Text && node.props.children === "Agent",
    ),
  ).toHaveLength(1);
  act(() => tree.unmount());
});

test("connection list reports query failures distinctly", async () => {
  const tree = renderFlow(
    new RecordingApi(true),
    React.createElement(AgentConnectionsList),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const rendered = JSON.stringify(tree.toJSON());
  expect(rendered).toContain("Couldn't load linked instances.");
  expect(rendered).toContain("Couldn't load agent access.");
  act(() => tree.unmount());
});

test("connection management controls target the expected API resources", async () => {
  const api = new RecordingApi();
  const tree = renderFlow(
    api,
    React.createElement(AgentConnectionsList),
    "data",
  );

  await act(async () =>
    labelled(tree.root, "Enable Home").props.onValueChange(true),
  );
  act(() => pressText(tree.root, "Remove"));
  await act(async () => pressText(tree.root, "Sure?"));
  act(() => pressText(tree.root, "Revoke"));
  await act(async () => pressText(tree.root, "Sure?"));

  expect(api.puts).toContainEqual({
    path: "/api/connections/Home",
    body: { name: "Home", enabled: true },
  });
  expect(api.deletes).toEqual(
    expect.arrayContaining([
      "/api/connections/Home",
      "/api/pairing/codex-token",
    ]),
  );
  act(() => tree.unmount());
});

test("connection token actions use the full token", async () => {
  const copy = jest.spyOn(Clipboard, "setStringAsync").mockResolvedValue(true);
  const share = jest
    .spyOn(Share, "share")
    .mockResolvedValue({ action: "sharedAction" });
  const tree = renderFlow(
    new RecordingApi(),
    React.createElement(AgentConnectionsList),
    "data",
  );

  await act(async () =>
    labelled(tree.root, "Copy Laptop token").props.onPress(),
  );
  await act(async () =>
    labelled(tree.root, "Share Laptop token").props.onPress(),
  );

  expect(copy).toHaveBeenCalledWith("codex-token");
  expect(share).toHaveBeenCalledWith({ message: "codex-token" });
  copy.mockRestore();
  share.mockRestore();
  act(() => tree.unmount());
});

test("bridge manage access opens its single agent policy directly", async () => {
  const tree=renderFlow(new RecordingApi(),React.createElement(AgentConnectionsList),"data");
  await act(async()=>labelled(tree.root,"Manage DM access for Laptop").props.onPress());
  await act(async()=>{});
  const rendered=JSON.stringify(tree.toJSON());
  expect(rendered).toContain("Everyone on this Agora can start a direct message");
  expect(rendered).toContain("Alice");
  act(()=>tree.unmount());
});

test("non-admins see the route denial instead of the management flow", () => {
  act(() => useSession.setState({ instanceAdmin: false }));
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(AddAgentScreen));
  });
  expect(JSON.stringify(tree.toJSON())).toContain("Admin access required");
  expect(JSON.stringify(tree.toJSON())).not.toContain("Add agent");
  act(() => tree.unmount());
});

test("unknown admin role renders a loading state instead of a denial", () => {
  const load = jest.fn(async () => {});
  act(() =>
    useSession.setState({
      instanceAdmin: false,
      instanceAdminKnown: false,
      load,
    }),
  );
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(AddAgentScreen));
  });
  const rendered = JSON.stringify(tree.toJSON());
  expect(rendered).toContain("Checking admin access…");
  expect(rendered).not.toContain("Admin access required");
  act(() => labelled(tree.root, "Retry checking admin access").props.onPress());
  expect(load).toHaveBeenCalledTimes(1);
  act(() => tree.unmount());
});
