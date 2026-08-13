import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveSocketUrl } from "./url.ts";

export const CHANNEL_ID = "agora";
export const DEFAULT_ACCOUNT_ID = "default";
export const DEFAULT_AGENT_ID = "openclaw";
export const DEFAULT_AGENT_NAME = "OpenClaw";
export const DEFAULT_MAX_FILE_MB = 10;
/** Agora rejects a post carrying more than five attachments. */
export const MAX_ATTACHMENTS = 5;

/** One Agora server plus the agent identity this account presents there. */
export type AgoraAccountConfig = {
  enabled?: boolean;
  url?: string;
  pairingToken?: string;
  pairingTokenFile?: string;
  agentId?: string;
  agentName?: string;
  requireMention?: boolean;
  /** Agora user ids allowed to drive this agent. Empty means nobody. */
  allowFrom?: string[];
  /** Set to "open" only when every human who can share a room is trusted. */
  dmSecurity?: string;
  maxFileMb?: number;
  /**
   * Receive agent-authored messages this agent was not mentioned in. Off by
   * default: it turns an ambient bot conversation into an execution path.
   */
  contextFeed?: boolean;
  accounts?: Record<string, AgoraAccountConfig>;
};

export type ResolvedAgoraAccount = {
  accountId: string | null;
  url: string;
  token: string;
  socketUrl: string;
  agentId: string;
  agentName: string;
  requireMention: boolean;
  allowFrom: string[];
  dmPolicy: string | undefined;
  maxFileBytes: number;
  contextFeed: boolean;
  config: AgoraAccountConfig;
};

export type AgoraAccountInspection = {
  enabled: boolean;
  configured: boolean;
  tokenStatus: "available" | "missing";
};

type ConfigLike = { channels?: Record<string, unknown> };

/** The env fallbacks mirror the Hermes plugin so both read one .env layout. */
const ENV_URL = "AGORA_URL";
const ENV_TOKEN = "AGORA_PAIRING_TOKEN";
const ENV_TOKEN_FILE = "AGORA_PAIRING_TOKEN_FILE";

export function readChannelSection(cfg: ConfigLike | undefined): AgoraAccountConfig {
  const section = cfg?.channels?.[CHANNEL_ID];
  return section && typeof section === "object" ? (section as AgoraAccountConfig) : {};
}

/**
 * Named accounts inherit every top-level field, so a single-account operator
 * never has to learn the `accounts` map and a multi-account one only overrides
 * what differs.
 */
export function readAccountSection(
  cfg: ConfigLike | undefined,
  accountId?: string | null,
): AgoraAccountConfig {
  const section = readChannelSection(cfg);
  const { accounts, ...defaults } = section;
  if (!accountId || accountId === DEFAULT_ACCOUNT_ID) {
    const named = accounts?.[DEFAULT_ACCOUNT_ID];
    return named ? { ...defaults, ...named } : defaults;
  }
  const named = accounts?.[accountId];
  if (!named) throw new Error(`agora: unknown account "${accountId}"`);
  return { ...defaults, ...named };
}

export function listAccountIds(cfg: ConfigLike | undefined): string[] {
  const named = Object.keys(readChannelSection(cfg).accounts ?? {});
  return named.length ? named : [DEFAULT_ACCOUNT_ID];
}

/**
 * A token file keeps the secret out of config.json, which OpenClaw rewrites on
 * every setup change and which operators routinely paste into issues.
 */
export function readToken(
  section: AgoraAccountConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const direct = section.pairingToken?.trim() || env[ENV_TOKEN]?.trim();
  if (direct) return direct;
  const file = section.pairingTokenFile?.trim() || env[ENV_TOKEN_FILE]?.trim();
  if (!file) return "";
  const expanded = expandHomePath(file);
  return readFileSync(expanded, "utf8").trim();
}

export function expandHomePath(file: string, home = homedir()): string {
  return file === "~" ? home : file.startsWith("~/") ? join(home, file.slice(2)) : file;
}

export function resolveMaxFileBytes(section: AgoraAccountConfig): number {
  const raw = Number(section.maxFileMb ?? DEFAULT_MAX_FILE_MB);
  const megabytes = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MAX_FILE_MB;
  return megabytes * 1024 * 1024;
}

export function resolveAgoraAccount(
  cfg: ConfigLike | undefined,
  accountId?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAgoraAccount {
  const section = readAccountSection(cfg, accountId);
  const url = (section.url?.trim() || env[ENV_URL]?.trim()) ?? "";
  if (!url) throw new Error("agora: url is required (channels.agora.url or AGORA_URL)");
  const token = readToken(section, env);
  if (!token) {
    throw new Error(
      "agora: a pairing token is required (channels.agora.pairingToken, pairingTokenFile, or AGORA_PAIRING_TOKEN)",
    );
  }
  return {
    accountId: accountId ?? null,
    url,
    token,
    socketUrl: resolveSocketUrl(url, token),
    agentId: section.agentId?.trim() || DEFAULT_AGENT_ID,
    agentName: section.agentName?.trim() || DEFAULT_AGENT_NAME,
    requireMention: section.requireMention === true,
    allowFrom: (section.allowFrom ?? []).map(entry => entry.trim()).filter(Boolean),
    dmPolicy: section.dmSecurity,
    maxFileBytes: resolveMaxFileBytes(section),
    contextFeed: section.contextFeed === true,
    config: section,
  };
}

/** Cheap enough to run from `channels status` without touching the network. */
export function inspectAgoraAccount(
  cfg: ConfigLike | undefined,
  accountId?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): AgoraAccountInspection {
  let section: AgoraAccountConfig;
  try {
    section = readAccountSection(cfg, accountId);
  } catch {
    return { enabled: false, configured: false, tokenStatus: "missing" };
  }
  let hasToken = false;
  try {
    hasToken = Boolean(readToken(section, env));
  } catch {
    hasToken = false;
  }
  const hasUrl = Boolean(section.url?.trim() || env[ENV_URL]?.trim());
  const configured = hasUrl && hasToken;
  return {
    enabled: configured && section.enabled !== false,
    configured,
    tokenStatus: hasToken ? "available" : "missing",
  };
}

/**
 * Default-deny. An empty allowlist admits nobody rather than everybody, so a
 * half-finished setup cannot expose the agent's tools to a whole server.
 */
export function isSenderAllowed(account: ResolvedAgoraAccount, senderId: string): boolean {
  if (account.dmPolicy === "open") return true;
  if (!senderId) return false;
  const normalized = senderId.trim().toLowerCase();
  return account.allowFrom.some(entry => entry.toLowerCase() === normalized);
}
