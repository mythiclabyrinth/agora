import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { agoraPlugin } from "./src/channel.ts";

export default defineChannelPluginEntry({
  id: "agora",
  name: "Agora",
  description: "Agora channel plugin — dials out to an Agora server over an authenticated WebSocket",
  plugin: agoraPlugin,
});
