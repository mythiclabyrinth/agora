import { afterEach, expect, it, vi } from "vitest";
import { ApiClient } from "../src/api/client";

afterEach(() => vi.unstubAllGlobals());

it("forwards keepalive for a pagehide draft save", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ rev: 1 }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const api = new ApiClient({ baseUrl: "https://agora.example", token: "test" });
  await api.put("/api/drafts", { body: "last words" }, { keepalive: true });
  expect(fetch).toHaveBeenCalledWith("https://agora.example/api/drafts", expect.objectContaining({
    method: "PUT", keepalive: true,
  }));
});
