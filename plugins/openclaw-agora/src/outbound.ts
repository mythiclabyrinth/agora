import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { getConnection } from "./clients.ts";
import { parseConversationId } from "./policy.ts";
import { normalizeThreadId, type AgoraOutboundAttachment } from "./protocol.ts";

/** Agora validates image magic bytes and rejects a post carrying anything else. */
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export type AgoraTarget = { channelId: string; threadId: number | null };

/**
 * Accepts the shapes core hands back: a bare channel id, a `channel:thread`
 * conversation id, or either with an `agora:` prefix, plus an explicit thread
 * id from the reply plan.
 */
export function resolveTarget(to: string, threadId?: string | number | null): AgoraTarget {
  const trimmed = String(to ?? "").trim();
  const withoutPrefix = trimmed.replace(/^agora:/i, "").replace(/^channel:/i, "");
  const parsed = parseConversationId(withoutPrefix);
  const explicit = normalizeThreadId(threadId);
  return { channelId: parsed.channelId, threadId: explicit ?? parsed.threadId };
}

export async function sendAgoraText(params: {
  accountId?: string | null;
  to: string;
  text: string;
  threadId?: string | number | null;
}): Promise<{ messageId: string }> {
  const { client } = getConnection(params.accountId);
  const target = resolveTarget(params.to, params.threadId);
  const messageId = await client.post({
    channelId: target.channelId,
    threadId: target.threadId,
    text: params.text,
  });
  return { messageId };
}

/** Core hands media over as a local path or an http(s) URL. */
async function readMedia(
  mediaUrl: string,
  limitBytes: number,
  readVia?: (filePath: string) => Promise<Buffer>,
): Promise<Buffer> {
  if (/^https?:\/\//i.test(mediaUrl)) {
    const response = await fetch(mediaUrl, { redirect: "follow" });
    if (!response.ok) throw new Error(`could not fetch media (${response.status})`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > limitBytes) throw new Error("media exceeds the Agora file limit");
    return buffer;
  }
  const info = await stat(mediaUrl);
  if (info.size > limitBytes) throw new Error("media exceeds the Agora file limit");
  return readVia ? await readVia(mediaUrl) : await readFile(mediaUrl);
}

export async function sendAgoraMedia(params: {
  accountId?: string | null;
  to: string;
  mediaUrl: string;
  text?: string;
  threadId?: string | number | null;
  readFile?: (filePath: string) => Promise<Buffer>;
}): Promise<{ messageId: string }> {
  const { client, account } = getConnection(params.accountId);
  const target = resolveTarget(params.to, params.threadId);
  const name = basename(new URL(params.mediaUrl, "file:///").pathname);
  const mime = IMAGE_MIME_BY_EXTENSION[extname(name).toLowerCase()];
  if (!mime) {
    // A non-image attachment makes Agora reject the whole post, caption and
    // all, so refuse here where the caller can still send the text alone.
    throw new Error("agora accepts image attachments only (png, jpeg, gif, webp)");
  }
  const data = await readMedia(params.mediaUrl, account.maxFileBytes, params.readFile);
  const attachment: AgoraOutboundAttachment = {
    filename: name,
    mime,
    data_b64: data.toString("base64"),
  };
  const messageId = await client.post({
    channelId: target.channelId,
    threadId: target.threadId,
    text: params.text ?? "",
    attachments: [attachment],
  });
  return { messageId };
}
