import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgoraInboundAttachment } from "./protocol.ts";
import { MAX_ATTACHMENTS } from "./config.ts";
import { resolveFileUrl } from "./url.ts";

export type LocalizedMedia = {
  path: string;
  contentType: string;
  kind: "image" | "video" | "audio" | "document" | "unknown";
};

export type LocalizedAttachments = {
  media: LocalizedMedia[];
  /** Human-readable notes for attachments that could not be materialized. */
  unavailable: string[];
};

export type FetchFile = (url: string, limitBytes: number) => Promise<Uint8Array>;

export function mediaKindFor(contentType: string): LocalizedMedia["kind"] {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType === "application/octet-stream" || !contentType) return "unknown";
  return "document";
}

/** Attachment names come from other people; never let one escape the temp dir. */
export function safeFileName(name: string | undefined, index: number): string {
  const base = basename(String(name ?? "").replace(/\\/g, "/"));
  // Control characters and leading dots are stripped so a name cannot hide
  // itself or escape the temp directory.
  const cleaned = base.replace(/[\u0000-\u001f]/g, "").replace(/^\.+/, "").trim();
  return cleaned || `attachment-${index}`;
}

/**
 * Fetch an attachment Agora did not inline. Redirects are refused rather than
 * followed: the pairing token is a bearer credential and a redirect could aim
 * it at another host. The cap is enforced while reading because a hostile
 * `content-length` proves nothing.
 */
export async function fetchAgoraFile(
  url: string,
  limitBytes: number,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${token}` },
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Agora file route redirected; refusing to forward the pairing token");
  }
  if (!response.ok) throw new Error(`Agora file route returned ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limitBytes) {
    throw new Error("attachment exceeds the configured file size limit");
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > limitBytes) {
    throw new Error("attachment exceeds the configured file size limit");
  }
  return buffer;
}

function decodeInline(encoded: string, limitBytes: number): Uint8Array {
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.byteLength > limitBytes) {
    throw new Error("attachment exceeds the configured file size limit");
  }
  return new Uint8Array(buffer);
}

/**
 * Writes inbound attachments into a per-turn temp directory and hands
 * OpenClaw their local paths. Anything that cannot be materialized is reported
 * as a note instead of disappearing, so the agent can say what it did not see.
 */
export async function localizeAttachments(params: {
  attachments: AgoraInboundAttachment[] | undefined;
  directory: string;
  socketUrl: string;
  agentId: string;
  token: string;
  limitBytes: number;
  fetchFile?: FetchFile;
  onError?: (message: string) => void;
}): Promise<LocalizedAttachments> {
  const media: LocalizedMedia[] = [];
  const unavailable: string[] = [];
  const fetchFile: FetchFile =
    params.fetchFile ?? ((url, limit) => fetchAgoraFile(url, limit, params.token));
  const list = (params.attachments ?? []).slice(0, MAX_ATTACHMENTS);
  const dropped = (params.attachments?.length ?? 0) - list.length;
  if (dropped > 0) unavailable.push(`${dropped} further attachment(s) were not fetched`);

  for (const [index, attachment] of list.entries()) {
    const name = safeFileName(attachment.filename, index);
    const size = Number(attachment.size ?? Number.NaN);
    const contentType = attachment.mime?.trim() || "application/octet-stream";
    try {
      if (Number.isFinite(size) && size > params.limitBytes) {
        unavailable.push(`${name} (${Math.round(size / 1024)} KB, over the file size limit)`);
        continue;
      }
      let bytes: Uint8Array;
      if (attachment.data_b64) {
        bytes = decodeInline(attachment.data_b64, params.limitBytes);
      } else if (attachment.id !== undefined && attachment.id !== null) {
        const url = resolveFileUrl(params.socketUrl, String(attachment.id), params.agentId);
        bytes = await fetchFile(url, params.limitBytes);
      } else {
        // Older Agora hubs omit the id for oversized attachments. Say so rather
        // than silently handing the agent a message with a hole in it.
        unavailable.push(`${name} (not retrievable from this Agora server)`);
        continue;
      }
      const path = join(params.directory, `${randomUUID()}-${name}`);
      await writeFile(path, bytes);
      media.push({ path, contentType, kind: mediaKindFor(contentType) });
    } catch (error) {
      unavailable.push(`${name} (${error instanceof Error ? error.message : String(error)})`);
      params.onError?.(`agora: could not localize attachment ${name}: ${String(error)}`);
    }
  }
  return { media, unavailable };
}

/** Scratch space; callers remove per-turn children as soon as dispatch ends. */
export async function createAttachmentDirectory(parent = tmpdir()): Promise<string> {
  return await mkdtemp(join(parent, "openclaw-agora-"));
}

export async function removeAttachmentDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}
