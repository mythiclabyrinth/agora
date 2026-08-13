import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createAttachmentDirectory,
  fetchAgoraFile,
  localizeAttachments,
  mediaKindFor,
  removeAttachmentDirectory,
  safeFileName,
} from "./attachments.ts";

const socketUrl = "wss://agora.example/agent/ws?token=tok";

async function withDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await createAttachmentDirectory();
  try {
    return await run(directory);
  } finally {
    await removeAttachmentDirectory(directory);
  }
}

const base = (directory: string) => ({
  directory,
  socketUrl,
  agentId: "openclaw",
  token: "tok",
  limitBytes: 1024,
});

describe("safeFileName", () => {
  it("strips directory traversal and control characters", () => {
    expect(safeFileName("../../etc/passwd", 0)).toBe("passwd");
    expect(safeFileName("C:\\windows\\system32\\evil.png", 0)).toBe("evil.png");
    expect(safeFileName(".hidden", 0)).toBe("hidden");
    expect(safeFileName("", 3)).toBe("attachment-3");
    expect(safeFileName(undefined, 1)).toBe("attachment-1");
  });
});

describe("mediaKindFor", () => {
  it("maps mime types to the agent-facing kind", () => {
    expect(mediaKindFor("image/png")).toBe("image");
    expect(mediaKindFor("audio/ogg")).toBe("audio");
    expect(mediaKindFor("application/pdf")).toBe("document");
    expect(mediaKindFor("application/octet-stream")).toBe("unknown");
  });
});

describe("localizeAttachments", () => {
  it("writes inline bytes to the scratch directory", async () => {
    await withDirectory(async directory => {
      const result = await localizeAttachments({
        ...base(directory),
        attachments: [
          { filename: "note.txt", mime: "text/plain", data_b64: Buffer.from("hi").toString("base64") },
        ],
      });
      expect(result.unavailable).toEqual([]);
      expect(result.media).toHaveLength(1);
      expect(result.media[0]!.contentType).toBe("text/plain");
      expect(await readFile(result.media[0]!.path, "utf8")).toBe("hi");
    });
  });

  it("fetches through the authenticated route when there are no inline bytes", async () => {
    await withDirectory(async directory => {
      const seen: string[] = [];
      const result = await localizeAttachments({
        ...base(directory),
        attachments: [{ id: 9, filename: "big.png", mime: "image/png", size: 100 }],
        fetchFile: async url => {
          seen.push(url);
          return new Uint8Array([1, 2, 3]);
        },
      });
      expect(seen).toEqual(["https://agora.example/agent/files/9?agent_id=openclaw"]);
      expect(result.media).toHaveLength(1);
      expect(result.media[0]!.kind).toBe("image");
    });
  });

  it("reports an oversized attachment instead of dropping it silently", async () => {
    await withDirectory(async directory => {
      const result = await localizeAttachments({
        ...base(directory),
        attachments: [{ id: 9, filename: "huge.bin", size: 99_999_999 }],
      });
      expect(result.media).toEqual([]);
      expect(result.unavailable[0]).toContain("over the file size limit");
    });
  });

  it("reports an attachment an older hub cannot serve", async () => {
    await withDirectory(async directory => {
      const result = await localizeAttachments({
        ...base(directory),
        attachments: [{ filename: "legacy.bin", size: 20 }],
      });
      expect(result.media).toEqual([]);
      expect(result.unavailable[0]).toContain("not retrievable");
    });
  });

  it("enforces the cap on inline bytes that lie about their size", async () => {
    await withDirectory(async directory => {
      const result = await localizeAttachments({
        ...base(directory),
        attachments: [
          { filename: "liar.bin", size: 1, data_b64: Buffer.alloc(4096).toString("base64") },
        ],
      });
      expect(result.media).toEqual([]);
      expect(result.unavailable[0]).toContain("file size limit");
    });
  });

  it("keeps at most five attachments and says how many it left", async () => {
    await withDirectory(async directory => {
      const attachments = Array.from({ length: 7 }, (_, index) => ({
        filename: `f${index}.txt`,
        data_b64: Buffer.from("x").toString("base64"),
      }));
      const result = await localizeAttachments({ ...base(directory), attachments });
      expect(result.media).toHaveLength(5);
      expect(result.unavailable[0]).toContain("2 further attachment");
    });
  });
});

describe("fetchAgoraFile", () => {
  const respond = (init: { status?: number; headers?: Record<string, string>; body?: Uint8Array }) =>
    (async () =>
      new Response(init.body ?? new Uint8Array([1]), {
        status: init.status ?? 200,
        headers: init.headers,
      })) as unknown as typeof fetch;

  it("refuses to follow a redirect that would leak the token", async () => {
    const redirecting = (async () =>
      new Response(null, { status: 302, headers: { location: "https://evil.example/" } })) as unknown as typeof fetch;
    await expect(fetchAgoraFile("https://agora.example/agent/files/1", 1024, "tok", redirecting)).rejects.toThrow(
      /redirect/,
    );
  });

  it("rejects a declared length over the cap before reading the body", async () => {
    await expect(
      fetchAgoraFile("https://agora.example/agent/files/1", 10, "tok", respond({ headers: { "content-length": "9999" } })),
    ).rejects.toThrow(/size limit/);
  });

  it("rejects a body that exceeds the cap despite the declared length", async () => {
    await expect(
      fetchAgoraFile(
        "https://agora.example/agent/files/1",
        4,
        "tok",
        respond({ headers: { "content-length": "1" }, body: new Uint8Array(64) }),
      ),
    ).rejects.toThrow(/size limit/);
  });

  it("surfaces an error status", async () => {
    await expect(
      fetchAgoraFile("https://agora.example/agent/files/1", 1024, "tok", respond({ status: 403 })),
    ).rejects.toThrow(/403/);
  });
});
