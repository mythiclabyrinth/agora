import { describe, expect, it } from "vitest";
import { redactSocketUrl, resolveFileUrl, resolveSocketUrl } from "./url.ts";

describe("resolveSocketUrl", () => {
  it("upgrades https to wss and appends the agent path", () => {
    expect(resolveSocketUrl("https://agora.example", "tok")).toBe(
      "wss://agora.example/agent/ws?token=tok",
    );
  });

  it("keeps a path prefix for reverse-proxied deployments", () => {
    expect(resolveSocketUrl("https://example.com/agora/", "tok")).toBe(
      "wss://example.com/agora/agent/ws?token=tok",
    );
  });

  it("does not double up an explicit agent path", () => {
    expect(resolveSocketUrl("wss://example.com/agent/ws", "tok")).toBe(
      "wss://example.com/agent/ws?token=tok",
    );
  });

  it("allows plaintext only on loopback", () => {
    expect(resolveSocketUrl("http://127.0.0.1:8080", "tok")).toBe(
      "ws://127.0.0.1:8080/agent/ws?token=tok",
    );
    expect(() => resolveSocketUrl("http://agora.example", "tok")).toThrow(/loopback/);
    expect(() => resolveSocketUrl("ws://192.168.1.10:8080", "tok")).toThrow(/loopback/);
  });

  it("rejects unusable input", () => {
    expect(() => resolveSocketUrl("", "tok")).toThrow(/required/);
    expect(() => resolveSocketUrl("agora.example", "tok")).toThrow(/http\(s\) or ws\(s\)/);
    expect(() => resolveSocketUrl("ftp://agora.example", "tok")).toThrow(/http\(s\) or ws\(s\)/);
    expect(() => resolveSocketUrl("https://agora.example", "")).toThrow(/token/);
  });
});

describe("resolveFileUrl", () => {
  it("targets the same host as the live socket", () => {
    const socket = resolveSocketUrl("https://agora.example", "tok");
    expect(resolveFileUrl(socket, "42", "openclaw")).toBe(
      "https://agora.example/agent/files/42?agent_id=openclaw",
    );
  });

  it("keeps plaintext for a loopback socket", () => {
    const socket = resolveSocketUrl("http://localhost:8080", "tok");
    expect(resolveFileUrl(socket, "7", "openclaw")).toBe(
      "http://localhost:8080/agent/files/7?agent_id=openclaw",
    );
  });

  it("keeps a reverse-proxy path prefix", () => {
    const socket = resolveSocketUrl("https://example.com/agora/", "tok");
    expect(resolveFileUrl(socket, "42", "openclaw")).toBe(
      "https://example.com/agora/agent/files/42?agent_id=openclaw",
    );
  });
});

describe("redactSocketUrl", () => {
  it("drops the pairing token", () => {
    const socket = resolveSocketUrl("https://agora.example", "super-secret");
    expect(redactSocketUrl(socket)).toBe("wss://agora.example/agent/ws");
    expect(redactSocketUrl(socket)).not.toContain("super-secret");
  });
});
