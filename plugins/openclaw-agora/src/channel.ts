import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  CHANNEL_ID,
  inspectAgoraAccount,
  listAccountIds,
  resolveAgoraAccount,
  type AgoraAccountConfig,
  type ResolvedAgoraAccount,
} from "./config.ts";
import { startAgoraAccount } from "./monitor.ts";
import { sendAgoraMedia, sendAgoraText } from "./outbound.ts";

export const agoraPlugin = createChatChannelPlugin<ResolvedAgoraAccount>({
  base: {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "Agora",
      selectionLabel: "Agora (plugin)",
      docsPath: "/channels/agora",
      docsLabel: "agora",
      blurb: "Chat app where people and AI agents share rooms; install the plugin to enable.",
      markdownCapable: true,
    },
    capabilities: {
      chatTypes: ["channel", "thread"],
      reactions: true,
      threads: true,
      media: true,
    },
    reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
    config: {
      listAccountIds: (cfg: OpenClawConfig) => listAccountIds(cfg),
      resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
        resolveAgoraAccount(cfg, accountId),
      inspectAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
        inspectAgoraAccount(cfg, accountId),
    },
    setup: {
      applyAccountConfig: ({ cfg, input }: { cfg: OpenClawConfig; input: AgoraAccountConfig }) => ({
        ...cfg,
        channels: {
          ...cfg.channels,
          [CHANNEL_ID]: {
            ...((cfg.channels as Record<string, AgoraAccountConfig>)?.[CHANNEL_ID] ?? {}),
            ...input,
          },
        },
      }),
    },
    gateway: {
      startAccount: startAgoraAccount,
    },
  },
  security: {
    dm: {
      channelKey: CHANNEL_ID,
      resolvePolicy: account => account.dmPolicy,
      resolveAllowFrom: account => account.allowFrom,
      // Nobody reaches the agent until an operator names them.
      defaultPolicy: "allowlist",
    },
  },
  // Agora threads are first-class conversations, so a reply to a thread message
  // belongs in that thread rather than at the top of the channel.
  threading: { topLevelReplyToMode: "thread" },
  outbound: {
    // The plugin owns the socket in this process, so replies go out directly
    // rather than through the gateway.
    base: { deliveryMode: "direct" },
    attachedResults: {
      channel: CHANNEL_ID,
      sendText: async ctx =>
        await sendAgoraText({
          accountId: ctx.accountId,
          to: ctx.to,
          text: ctx.text,
          threadId: ctx.threadId,
        }),
      sendMedia: async ctx =>
        await sendAgoraMedia({
          accountId: ctx.accountId,
          to: ctx.to,
          mediaUrl: ctx.mediaUrl ?? "",
          text: ctx.text,
          threadId: ctx.threadId,
          readFile: ctx.mediaReadFile,
        }),
    },
  },
});
