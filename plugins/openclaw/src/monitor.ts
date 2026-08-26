import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { AgoraClient } from "./client.ts";
import { registerConnection, unregisterConnection } from "./clients.ts";
import { CHANNEL_ID, type ResolvedAgoraAccount } from "./config.ts";
import { decideInbound, resolveRoute } from "./policy.ts";
import {
  createAttachmentDirectory,
  localizeAttachments,
  removeAttachmentDirectory,
} from "./attachments.ts";
import { normalizeMessageId, type AgoraInboundFrame } from "./protocol.ts";

/** Agora's convention: 👀 while working, then ☑️ after a completed turn. */
const ACK_EMOJI = "👀";
const DONE_EMOJI = "☑️";

function describeAuthor(frame: AgoraInboundFrame): { id: string; name: string; isBot: boolean } {
  const author = frame.author ?? {};
  const id = String(author.id ?? "");
  return {
    id,
    name: String(author.name || id || "Agora user"),
    isBot: (author.type ?? "user") !== "user",
  };
}

/**
 * Runs one Agora account for as long as the gateway keeps it started. The
 * plugin dials out, so nothing here opens a listening port on the host.
 */
export async function startAgoraAccount(
  ctx: ChannelGatewayContext<ResolvedAgoraAccount>,
): Promise<void> {
  const account = ctx.account;
  // `ctx.channelRuntime` is intentionally loose in the contract type; the
  // helpers it carries are the ones described by PluginRuntime["channel"].
  const channelRuntime = ctx.channelRuntime as PluginRuntime["channel"] | undefined;
  if (!channelRuntime) {
    ctx.log?.warn?.("agora: channel runtime unavailable; not starting the account");
    return;
  }
  const runtime = channelRuntime;
  const accountId = ctx.accountId;
  const directory = await createAttachmentDirectory();

  const client = new AgoraClient({
    socketUrl: account.socketUrl,
    agentId: account.agentId,
    agentName: account.agentName,
    requireMention: account.requireMention,
    contextFeed: account.contextFeed,
    botLoopLimit: account.botLoopLimit,
    log: message => ctx.log?.info?.(message),
    warn: message => ctx.log?.warn?.(message),
    onConnected: () => {
      ctx.setStatus({ ...ctx.getStatus(), accountId, connected: true } as never);
    },
    onDisconnected: () => {
      ctx.setStatus({ ...ctx.getStatus(), accountId, connected: false } as never);
    },
    onInbound: frame => handleInbound(frame),
  });

  async function handleInbound(frame: AgoraInboundFrame): Promise<void> {
    const route = resolveRoute(frame);
    const decision = decideInbound({
      frame,
      account,
      hasMedia: (frame.attachments?.length ?? 0) > 0,
    });
    if (!decision.handle) {
      ctx.log?.info?.(`agora: skipped message in ${route.conversationId} (${decision.reason})`);
      return;
    }

    const turnDirectory = await createAttachmentDirectory(directory);
    let indicatorsCleared = false;
    let completed = false;
    let clearIndicators = async () => {};
    try {
      const { media, unavailable } = await localizeAttachments({
        attachments: frame.attachments,
        directory: turnDirectory,
        socketUrl: account.socketUrl,
        agentId: account.agentId,
        token: account.token,
        limitBytes: account.maxFileBytes,
        onError: message => ctx.log?.warn?.(message),
      });

      const author = describeAuthor(frame);
      const messageId = normalizeMessageId(frame.message_id);
      const rawText = String(frame.text ?? "");
      const bodyForAgent = unavailable.length
        ? `${rawText}\n\n[attachments not retrieved: ${unavailable.join("; ")}]`.trim()
        : rawText;

      const agentRoute = runtime.routing.resolveAgentRoute({
        cfg: ctx.cfg,
        channel: CHANNEL_ID,
        accountId,
        peer: { kind: "channel", id: route.conversationId },
        // A thread inherits its channel's binding when nothing targets it directly.
        parentPeer: route.threadId === null ? null : { kind: "channel", id: route.channelId },
      });
      const storePath = runtime.session.resolveStorePath(ctx.cfg.session?.store, {
        agentId: agentRoute.agentId,
      });

      const ctxPayload = runtime.inbound.buildContext({
        channel: CHANNEL_ID,
        accountId,
        provider: CHANNEL_ID,
        surface: CHANNEL_ID,
        messageId: messageId === null ? undefined : String(messageId),
        from: `agora:channel:${route.conversationId}`,
        sender: { id: author.id, name: author.name, isBot: author.isBot },
        conversation: {
          kind: "channel",
          id: route.conversationId,
          label: String(frame.chat_name ?? route.channelId),
          nativeChannelId: route.channelId,
          ...(route.threadId === null
            ? {}
            : { threadId: String(route.threadId), parentId: route.channelId }),
          routePeer: { kind: "channel", id: route.conversationId },
        },
        route: {
          agentId: agentRoute.agentId,
          accountId,
          routeSessionKey: agentRoute.sessionKey,
          mainSessionKey: agentRoute.mainSessionKey,
          createIfMissing: true,
        },
        reply: {
          to: route.conversationId,
          nativeChannelId: route.channelId,
          ...(route.threadId === null ? {} : { messageThreadId: route.threadId }),
          sourceReplyDeliveryMode: route.threadId === null ? "channel" : "thread",
        },
        message: {
          rawBody: rawText,
          bodyForAgent,
          commandBody: rawText.trim(),
          senderLabel: author.name,
        },
        media,
      });

      if (messageId !== null) {
        await client.react({
          channelId: route.channelId,
          messageId,
          emoji: ACK_EMOJI,
          action: "add",
        });
      }
      await client.setTyping(route.channelId, route.threadId, true);

      // Concurrent turns in one conversation share provider typing/reaction
      // state. Proper overlap handling needs per-conversation reference counts;
      // until then a finishing turn may clear another turn's indicators early.
      clearIndicators = async () => {
        if (indicatorsCleared) return;
        indicatorsCleared = true;
        await client.setTyping(route.channelId, route.threadId, false);
        if (messageId !== null) {
          await client.react({
            channelId: route.channelId,
            messageId,
            emoji: ACK_EMOJI,
            action: "remove",
          });
          if (completed) {
            await client.react({
              channelId: route.channelId,
              messageId,
              emoji: DONE_EMOJI,
              action: "add",
            });
          }
        }
      };

      await runtime.inbound.run({
        channel: CHANNEL_ID,
        accountId,
        raw: frame,
        adapter: {
          ingest: () => ({
            id: messageId === null ? `${route.conversationId}:${frame.message_id ?? "?"}` : String(messageId),
            rawText,
            textForAgent: bodyForAgent,
            textForCommands: rawText.trim(),
            raw: frame,
          }),
          resolveTurn: () => ({
            cfg: ctx.cfg,
            channel: CHANNEL_ID,
            accountId,
            agentId: agentRoute.agentId,
            routeSessionKey: agentRoute.sessionKey,
            storePath,
            ctxPayload,
            recordInboundSession: runtime.session.recordInboundSession,
            dispatchReplyWithBufferedBlockDispatcher:
              runtime.reply.dispatchReplyWithBufferedBlockDispatcher,
            delivery: {
              deliver: async payload => {
                const text = payload.text?.trim();
                if (!text) return;
                // Every reply carries the thread id back: a reply posted
                // without it lands in the channel root instead of the thread.
                await client.post({
                  channelId: route.channelId,
                  threadId: route.threadId,
                  text,
                });
                return { visibleReplySent: true };
              },
              onError: (error, info) => {
                ctx.log?.warn?.(`agora: ${info.kind} reply failed: ${String(error)}`);
              },
            },
            record: {
              createIfMissing: true,
              onRecordError: error =>
                ctx.log?.warn?.(`agora: could not record session metadata: ${String(error)}`),
            },
          }),
        },
      });
      completed = true;
    } catch (error) {
      ctx.log?.warn?.(`agora: inbound dispatch failed: ${String(error)}`);
    } finally {
      await clearIndicators();
      await removeAttachmentDirectory(turnDirectory);
    }
  }

  const connection = { client, account };
  registerConnection(accountId, connection);
  client.start();

  await new Promise<void>(resolve => {
    const finish = () => {
      void (async () => {
        unregisterConnection(accountId, connection);
        await client.stop();
        await removeAttachmentDirectory(directory);
        resolve();
      })();
    };
    if (ctx.abortSignal.aborted) finish();
    else ctx.abortSignal.addEventListener("abort", finish, { once: true });
  });
}
