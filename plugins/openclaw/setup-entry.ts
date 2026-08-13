import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { agoraPlugin } from "./src/channel.ts";

export default defineSetupPluginEntry(agoraPlugin);
