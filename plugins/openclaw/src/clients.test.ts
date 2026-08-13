import { afterEach, describe, expect, it } from "vitest";
import {
  getConnection,
  listConnections,
  registerConnection,
  unregisterConnection,
  type LiveAgoraConnection,
} from "./clients.ts";

const connection = (name: string) => ({
  client: { name },
  account: { accountId: name },
}) as unknown as LiveAgoraConnection;

afterEach(() => {
  for (const live of listConnections()) {
    const id = String(live.account.accountId ?? "default");
    unregisterConnection(id, live);
  }
});

describe("live Agora connections", () => {
  it("does not let stale teardown remove a replacement", () => {
    const oldConnection = connection("default");
    const replacement = connection("default");
    registerConnection("default", oldConnection);
    registerConnection("default", replacement);
    unregisterConnection("default", oldConnection);
    expect(getConnection("default")).toBe(replacement);
  });

  it("requires an account id when multiple non-default accounts are live", () => {
    const one = connection("one");
    const two = connection("two");
    registerConnection("one", one);
    registerConnection("two", two);
    expect(() => getConnection()).toThrow(/accountId is required/);
    expect(getConnection("two")).toBe(two);
  });
});
