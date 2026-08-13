import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  inspectAgoraAccount,
  expandHomePath,
  isSenderAllowed,
  listAccountIds,
  resolveAgoraAccount,
  resolveMaxFileBytes,
} from "./config.ts";

const cfg = (agora: Record<string, unknown>) => ({ channels: { agora } });
const noEnv = {} as NodeJS.ProcessEnv;

describe("resolveAgoraAccount", () => {
  it("resolves the single-account form", () => {
    const account = resolveAgoraAccount(
      cfg({ url: "https://agora.example", pairingToken: "tok", allowFrom: ["alice"] }),
      undefined,
      noEnv,
    );
    expect(account.socketUrl).toBe("wss://agora.example/agent/ws?token=tok");
    expect(account.agentId).toBe("openclaw");
    expect(account.allowFrom).toEqual(["alice"]);
    expect(account.contextFeed).toBe(false);
  });

  it("lets a named account inherit and override top-level fields", () => {
    const config = cfg({
      url: "https://agora.example",
      pairingToken: "tok",
      allowFrom: ["alice"],
      accounts: { work: { agentId: "work-bot", allowFrom: ["bob"] } },
    });
    const account = resolveAgoraAccount(config, "work", noEnv);
    expect(account.agentId).toBe("work-bot");
    expect(account.allowFrom).toEqual(["bob"]);
    expect(account.url).toBe("https://agora.example");
    expect(listAccountIds(config)).toEqual(["work"]);
  });

  it("falls back to the environment", () => {
    const account = resolveAgoraAccount(cfg({}), undefined, {
      AGORA_URL: "https://agora.example",
      AGORA_PAIRING_TOKEN: "env-token",
    } as NodeJS.ProcessEnv);
    expect(account.token).toBe("env-token");
  });

  it("reads a token file so the secret stays out of config.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "agora-token-"));
    const file = join(dir, "token");
    writeFileSync(file, "file-token\n");
    const account = resolveAgoraAccount(
      cfg({ url: "https://agora.example", pairingTokenFile: file }),
      undefined,
      noEnv,
    );
    expect(account.token).toBe("file-token");
  });

  it("expands a home-relative token file path", () => {
    expect(expandHomePath("~/.openclaw/agora-token", "/home/alice")).toBe(
      "/home/alice/.openclaw/agora-token",
    );
    expect(expandHomePath("/secure/token", "/home/alice")).toBe("/secure/token");
  });

  it("refuses to start without a url or token", () => {
    expect(() => resolveAgoraAccount(cfg({ pairingToken: "tok" }), undefined, noEnv)).toThrow(/url/);
    expect(() =>
      resolveAgoraAccount(cfg({ url: "https://agora.example" }), undefined, noEnv),
    ).toThrow(/pairing token/);
  });

  it("rejects an unknown named account", () => {
    expect(() => resolveAgoraAccount(cfg({ url: "x", pairingToken: "t" }), "nope", noEnv)).toThrow(
      /unknown account/,
    );
  });
});

describe("inspectAgoraAccount", () => {
  it("reports a configured account without materializing the token", () => {
    const result = inspectAgoraAccount(
      cfg({ url: "https://agora.example", pairingToken: "tok" }),
      undefined,
      noEnv,
    );
    expect(result).toEqual({ enabled: true, configured: true, tokenStatus: "available" });
  });

  it("reports missing configuration instead of throwing", () => {
    expect(inspectAgoraAccount(cfg({}), undefined, noEnv)).toEqual({
      enabled: false,
      configured: false,
      tokenStatus: "missing",
    });
    expect(inspectAgoraAccount(cfg({}), "ghost", noEnv).configured).toBe(false);
  });

  it("treats an explicitly disabled account as not enabled", () => {
    const result = inspectAgoraAccount(
      cfg({ url: "https://agora.example", pairingToken: "tok", enabled: false }),
      undefined,
      noEnv,
    );
    expect(result).toEqual({ enabled: false, configured: true, tokenStatus: "available" });
  });
});

describe("resolveMaxFileBytes", () => {
  it("defaults to 10 MB and ignores nonsense", () => {
    expect(resolveMaxFileBytes({})).toBe(10 * 1024 * 1024);
    expect(resolveMaxFileBytes({ maxFileMb: 0 })).toBe(10 * 1024 * 1024);
    expect(resolveMaxFileBytes({ maxFileMb: 25 })).toBe(25 * 1024 * 1024);
  });
});

describe("isSenderAllowed", () => {
  const account = (over: Record<string, unknown>) =>
    ({ allowFrom: [], dmPolicy: undefined, ...over }) as never;

  it("denies by default when no allowlist is configured", () => {
    expect(isSenderAllowed(account({}), "alice")).toBe(false);
  });

  it("matches allowlist entries case-insensitively", () => {
    expect(isSenderAllowed(account({ allowFrom: ["Alice"] }), "alice")).toBe(true);
    expect(isSenderAllowed(account({ allowFrom: ["alice"] }), "mallory")).toBe(false);
  });

  it("admits everyone only under an explicit open policy", () => {
    expect(isSenderAllowed(account({ dmPolicy: "open" }), "anyone")).toBe(true);
  });

  it("denies an empty sender id", () => {
    expect(isSenderAllowed(account({ allowFrom: ["alice"] }), "")).toBe(false);
  });
});
