import type { AgoraClient } from "./client.ts";
import type { ResolvedAgoraAccount } from "./config.ts";
import { DEFAULT_ACCOUNT_ID } from "./config.ts";

export type LiveAgoraConnection = {
  client: AgoraClient;
  account: ResolvedAgoraAccount;
};

/**
 * Outbound sends arrive from core with only an account id, so the live socket
 * for that account has to be findable from module scope.
 */
const connections = new Map<string, LiveAgoraConnection>();

export function registerConnection(accountId: string, connection: LiveAgoraConnection): void {
  connections.set(accountId, connection);
}

export function unregisterConnection(accountId: string, connection: LiveAgoraConnection): void {
  if (connections.get(accountId) === connection) connections.delete(accountId);
}

export function getConnection(accountId?: string | null): LiveAgoraConnection {
  const key = accountId ?? DEFAULT_ACCOUNT_ID;
  let connection = connections.get(key);
  if (!connection && !accountId) {
    if (connections.size > 1) {
      throw new Error("agora: accountId is required when multiple accounts are connected");
    }
    connection = connections.values().next().value;
  }
  if (!connection) {
    throw new Error(`agora: account "${key}" is not connected`);
  }
  return connection;
}

export function listConnections(): LiveAgoraConnection[] {
  return [...connections.values()];
}
