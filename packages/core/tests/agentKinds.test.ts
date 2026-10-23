import { describe, expect, it } from "vitest";
import { agentWsUrl } from "../src/api/client";
import { inferPairingKind } from "../src/lib/agentKinds";

describe("inferPairingKind", () => {
  it.each(["codex", "cursor", "claude", "antigravity", "claw", "hermes"] as const)(
    "prefers explicit %s metadata",
    (kind) => {
      expect(inferPairingKind({ name: "anything", kind })).toBe(kind);
    },
  );

  it("rejects unknown explicit metadata", () => {
    expect(
      inferPairingKind({ name: "anything", kind: "future-agent" }),
    ).toBeNull();
  });

  it.each([
    ["Codex", "codex"],
    ["codex-macbook", "codex"],
    ["cursor_work", "cursor"],
    ["Claude-home", "claude"],
    ["antigravity-cli", "antigravity"],
    ["Antigravity_laptop", "antigravity"],
    ["agy", "antigravity"],
    ["agy-work", "antigravity"],
    ["OpenClaw_server", "claw"],
    ["hermes", "hermes"],
  ] as const)("infers legacy name %s", (name, expected) => {
    expect(inferPairingKind({ name })).toBe(expected);
  });

  it("does not infer from incidental substrings", () => {
    expect(inferPairingKind({ name: "my-codex" })).toBeNull();
    expect(inferPairingKind({ name: "agyle" })).toBeNull();
    expect(inferPairingKind({ name: "custom integration" })).toBeNull();
  });
});

describe("agentWsUrl", () => {
  it("uses the https server origin and encodes the credential", () => {
    expect(agentWsUrl("https://agora.example/app/", "token with spaces")).toBe(
      "wss://agora.example/agent/ws?token=token%20with%20spaces",
    );
  });

  it("keeps local http servers on ws", () => {
    expect(agentWsUrl("http://localhost:8787", "abc")).toBe(
      "ws://localhost:8787/agent/ws?token=abc",
    );
  });
});
